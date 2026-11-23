//! HCEM named-pipe server (Rust side, tokio named pipe).
//!
//! Direction: Rust creates the pipe and waits; Node connects with net.connect.
//! (The opposite direction - Rust opening a Node-created pipe - returns
//! ERROR_ACCESS_DENIED on Windows, verified.)
//!
//! Constraints:
//! 1. No TCP port: PIPE_PATH is a kernel named-pipe object.
//! 2. Never blocks the UI thread: everything runs in tokio tasks; business code
//!    only enqueues frames through send_frame (try_send).
//! 3. Length-prefixed framing: [4B length LE][1B type][length bytes JSON].
//!    Reader does read_exact(5) then read_exact(len), so no sticky/half packets.
//! 4. Auto rebuild pipe after disconnect (300ms backoff).

use std::sync::Mutex;
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::mpsc;

pub const PIPE_PATH: &str = r"\\.\pipe\hcem-bridge";
const MAX_FRAME: usize = 8 * 1024 * 1024;

pub const T_STATE: u8 = 0;
pub const T_CMD: u8 = 1;
pub const T_ACK: u8 = 2;
pub const T_LOG: u8 = 3;
pub const T_PING: u8 = 4;
pub const T_PONG: u8 = 5;
pub const T_HELLO: u8 = 6;

/// Global sender: set when a client connects, used by business commands.
static OUT_TX: Mutex<Option<mpsc::Sender<Vec<u8>>>> = Mutex::new(None);

fn now_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// 桥接日志统一走 logging 模块（logs\hcem-YYYY-MM-DD.log）
pub fn log(msg: &str) {
    crate::logging::log("INFO", "bridge", msg);
}

pub fn encode_frame(kind: u8, payload: &str) -> Vec<u8> {
    let body = payload.as_bytes();
    let mut v = Vec::with_capacity(5 + body.len());
    v.extend_from_slice(&(body.len() as u32).to_le_bytes());
    v.push(kind);
    v.extend_from_slice(body);
    v
}

/// Send one frame from business code (thread-safe, non-blocking).
pub fn send_frame(kind: u8, payload: &str) -> bool {
    let guard = match OUT_TX.lock() {
        Ok(g) => g,
        Err(_) => return false,
    };
    match guard.as_ref() {
        Some(tx) => tx.try_send(encode_frame(kind, payload)).is_ok(),
        None => false,
    }
}

pub fn is_connected() -> bool {
    OUT_TX.lock().map(|g| g.is_some()).unwrap_or(false)
}

/// 自动拉起插件侧 Node 进程（不弹控制台窗口）
///
/// HCEM.exe 是总控：桥接等待 6 秒仍没有 Node 连进来，就自己启动一份，
/// 避免"忘了开 Node → 开关点了没反应"。
fn spawn_node() {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let node = "node";
    let server = crate::exe_dir().join("plugin").join("lib").join("bridge").join("pipe-server.mjs");
    if !server.exists() {
        log("spawn node skipped: node.exe or pipe-server.mjs missing");
        return;
    }
    match std::process::Command::new(node)
        .arg(&server)
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
    {
        Ok(child) => log(&format!("spawned node pid={}", child.id())),
        Err(e) => log(&format!("spawn node failed: {e}")),
    }
}

pub fn start(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            let server = match tokio::net::windows::named_pipe::ServerOptions::new()
                .pipe_mode(tokio::net::windows::named_pipe::PipeMode::Byte)
                .first_pipe_instance(false)
                .create(PIPE_PATH)
            {
                Ok(s) => s,
                Err(e) => {
                    log(&format!("CreateNamedPipe failed: {e}"));
                    tokio::time::sleep(Duration::from_millis(800)).await;
                    continue;
                }
            };

            // 等 Node 连入；超过 6 秒没人连，就自己拉起一份 Node
            match tokio::time::timeout(Duration::from_secs(6), server.connect()).await {
                Ok(Ok(())) => {}
                Ok(Err(e)) => {
                    log(&format!("connect failed: {e}"));
                    tokio::time::sleep(Duration::from_millis(300)).await;
                    continue;
                }
                Err(_) => {
                    log("no node client in 6s, spawning one");
                    spawn_node();
                    tokio::time::sleep(Duration::from_secs(3)).await;
                    continue;
                }
            }
            log("node connected");

            let (mut rd, mut wr) = tokio::io::split(server);
            let (tx, mut rx) = mpsc::channel::<Vec<u8>>(64);
            if let Ok(mut g) = OUT_TX.lock() {
                *g = Some(tx.clone());
            }

            let writer = tokio::spawn(async move {
                while let Some(buf) = rx.recv().await {
                    if wr.write_all(&buf).await.is_err() {
                        break;
                    }
                    let _ = wr.flush().await;
                }
            });

            let hb_tx = tx.clone();
            let heartbeat = tokio::spawn(async move {
                loop {
                    tokio::time::sleep(Duration::from_secs(2)).await;
                    let payload = format!("{{\"t\":{}}}", now_ms());
                    if hb_tx.send(encode_frame(T_PING, &payload)).await.is_err() {
                        break;
                    }
                }
            });

            let app2 = app.clone();
            loop {
                let mut head = [0u8; 5];
                if rd.read_exact(&mut head).await.is_err() {
                    break;
                }
                let len = u32::from_le_bytes([head[0], head[1], head[2], head[3]]) as usize;
                let kind = head[4];
                if len > MAX_FRAME {
                    log("frame too large, drop connection");
                    break;
                }
                let mut body = vec![0u8; len];
                if len > 0 && rd.read_exact(&mut body).await.is_err() {
                    break;
                }
                let text = String::from_utf8_lossy(&body).to_string();

                match kind {
                    T_STATE => {
                        log(&format!("STATE {text}"));
                        let _ = app2.emit("hcem://bridge-state", text.clone());
                        // Node pushes HSL -> paint the orb
                        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
                            let h = v.get("h").and_then(|x| x.as_f64());
                            let s = v.get("s").and_then(|x| x.as_f64());
                            let l = v.get("l").and_then(|x| x.as_f64());
                            if let (Some(h), Some(s), Some(l)) = (h, s, l) {
                                let js = format!(
                                    "window.applyHSL && window.applyHSL({h}, {s}, {l});"
                                );
                                // 悬浮球：实时上色
                                if let Some(orb) = app2.get_webview_window("orb") {
                                    let _ = orb.eval(&js);
                                }
                                // 菜单：HSL 引擎页要看到同样的数值
                                if let Some(menu) = app2.get_webview_window("menu") {
                                    let _ = menu.eval(&js);
                                }
                            }
                            // 显存让位：services 把被踢掉的开关同步关掉后，菜单按钮要跟着变
                            if let Some(mods) = v.get("mods") {
                                if let Ok(js_json) = serde_json::to_string(mods) {
                                    let js = format!("window.applyMods && window.applyMods({js_json});");
                                    if let Some(menu) = app2.get_webview_window("menu") {
                                        let _ = menu.eval(&js);
                                    }
                                }
                                let _ = app2.emit(
                                    "hcem://mods-evicted",
                                    v.get("evicted").cloned().unwrap_or(serde_json::Value::Null),
                                );
                            }
                            // 语音输入结果：只转发给前端（文件由 voice-input.mjs 写，这里不重复写，
                            // 否则会覆盖掉它带的 source 字段）
                            if let Some(vi) = v.get("voiceInput").and_then(|x| x.as_str()) {
                                if !vi.trim().is_empty() {
                                    let _ = app2.emit("hcem://voice-input", vi.to_string());
                                }
                            }
                            // 通话状态：pipe-server 转达插件的 /call 结果，悬浮球要显示波形和阶段
                            if let Some(vc) = v.get("voiceCall") {
                                let _ = app2.emit("hcem://voice-call", vc.clone());
                                if let Ok(js_json) = serde_json::to_string(vc) {
                                    let js = format!(
                                        "window.applyVoiceCall && window.applyVoiceCall({js_json});"
                                    );
                                    if let Some(orb) = app2.get_webview_window("orb") {
                                        let _ = orb.eval(&js);
                                    }
                                }
                            }
                        }
                    }
                    T_HELLO => {
                        log(&format!("HELLO {text}"));
                        let _ = app2.emit("hcem://bridge-hello", text);
                    }
                    T_PONG => {
                        // 心跳回包不写日志（2 秒一条会把日志撑爆），只转发给前端
                        let _ = app2.emit("hcem://bridge-pong", text);
                    }
                    T_ACK => {
                        log(&format!("ACK {text}"));
                    }
                    T_CMD => {
                        log(&format!("CMD {text}"));
                        let _ = app2.emit("hcem://bridge-cmd", text);
                    }
                    _ => {
                        log(&format!("frame type={kind} {text}"));
                        let _ = app2.emit("hcem://bridge-frame", text);
                    }
                }
            }

            heartbeat.abort();
            drop(tx);
            let _ = writer.await;
            if let Ok(mut g) = OUT_TX.lock() {
                *g = None;
            }
            log("node disconnected, rebuild pipe");
            tokio::time::sleep(Duration::from_millis(300)).await;
        }
    });
}
