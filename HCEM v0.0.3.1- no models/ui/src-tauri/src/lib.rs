// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod bridge;
mod logging;

use std::sync::Mutex;
use tauri::Manager;


/// 安装目录 = 本 exe 所在目录（任意盘符/路径，不再写死盘符）
pub fn exe_dir() -> std::path::PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|x| x.to_path_buf()))
        .unwrap_or_else(|| std::path::PathBuf::from("."))
}
pub fn data_dir() -> std::path::PathBuf {
    exe_dir().join("data")
}
pub fn tmp_dir() -> std::path::PathBuf {
    exe_dir().join(".tmp")
}
pub fn tauri_data_dir() -> std::path::PathBuf {
    exe_dir().join(".tauri-data")
}

static PENDING_PAGE: Mutex<Option<String>> = Mutex::new(None);

/// 显示主菜单窗口（可带页面参数）
/// 各子页的默认窗口高度（前端未上报时兜底）
fn page_height(page: &str) -> f64 {
    match page {
        "persona" => 940.0,
        "import" => 600.0,
        "hsl" => 660.0,
        "schedule" => 920.0,
        "multi" => 820.0,
        "settings" => 600.0,
        _ => 720.0,
    }
}

#[tauri::command]
fn open_menu(app: tauri::AppHandle, page: Option<String>) -> bool {
    // 左键点球：先把快捷菜单收起来，否则它会盖在球上继续吃掉后续点击
    if let Some(c) = app.get_webview_window("ctx") {
        let _ = c.hide();
    }
    dbg_click("open_menu".to_string());
    if let Some(win) = app.get_webview_window("menu") {
        let _ = win.show();
        // 这里必须和创建窗口时的下限一致，否则每次打开菜单都会把尺寸顶回 980，
        // 用户怎么拖都缩不下去（实测踩过）。
        let _ = win.set_min_size(Some(tauri::LogicalSize::new(640.0, 460.0)));
        let _ = win.set_max_size(Some(tauri::LogicalSize::new(1800.0, 1400.0)));
        if let Some(p) = page.clone() {
            if let Ok(mut g) = PENDING_PAGE.lock() {
                *g = Some(p.clone());
            }
        }
        if let Some(p) = page.as_deref() {
            let (mw, mh) = load_menu_size();
            let _ = win.set_size(tauri::LogicalSize::new(mw, mh));
            let _ = win.center();
            // 直接按页重新加载菜单（eval 在 WebView 首次加载时不可靠）
            if let Ok(u) = format!("http://tauri.localhost/menu.html?page={}", p).parse() {
                let _ = win.navigate(u);
            }
        }
        let _ = win.set_focus();
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(tmp_dir().join("open-menu.log"))
        {
            use std::io::Write;
            let sz = win.outer_size();
            let _ = writeln!(f, "open_menu page={:?} size={:?}", page, sz);
        }
        if let Some(p) = page {
            // 首次显示时页面可能还没加载完，延迟再跳页
            let js = format!("window.gotoPage && window.gotoPage({:?});", p);
            let app2 = app.clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(900));
                if let Some(w) = app2.get_webview_window("menu") {
                    let _ = w.eval(&js);
                }
            });
        }
        return true;
    }
    false
}

/// 关闭主菜单（菜单里的「返回」按钮）
#[tauri::command]
fn take_pending_page() -> Option<String> {
    PENDING_PAGE.lock().ok().and_then(|mut g| g.take())
}

#[tauri::command]
fn close_menu(app: tauri::AppHandle) -> bool {
    if let Some(win) = app.get_webview_window("menu") {
        let _ = win.hide();
        return true;
    }
    false
}

/// 隐藏悬浮球（菜单展开时可选调用）
#[tauri::command]
fn set_orb_visible(app: tauri::AppHandle, visible: bool) -> bool {
    if let Some(win) = app.get_webview_window("orb") {
        if visible {
            let _ = win.show();
        } else {
            let _ = win.hide();
        }
        return true;
    }
    false
}











/// 在悬浮球左侧弹出快捷菜单
#[tauri::command]
fn open_ctx(app: tauri::AppHandle) -> bool {
    dbg_click("open_ctx".to_string());
    // 已存在且正在显示 → 这次右键当"收起"用（避免透明窗口盖住悬浮球吃点击）
    if let Some(win) = app.get_webview_window("ctx") {
        if win.is_visible().unwrap_or(false) {
            let _ = win.hide();
            return true;
        }
    }

    if let Some(ctx) = app.get_webview_window("ctx") {
        if let Some(orb) = app.get_webview_window("orb") {
            if let (Ok(pos), Ok(size)) = (orb.outer_position(), orb.outer_size()) {
                let ctx_size = ctx
                    .outer_size()
                    .unwrap_or(tauri::PhysicalSize::new(200, 300));
                let x = pos.x - ctx_size.width as i32 - 14;
                let y = pos.y + (size.height as i32 - ctx_size.height as i32) / 2;
                let _ = ctx.set_position(tauri::PhysicalPosition::new(x.max(0), y.max(0)));
            }
        }
        let _ = ctx.show();
        let _ = ctx.set_focus();
        return true;
    }
    false
}

#[tauri::command]
fn resize_ctx(app: tauri::AppHandle, width: f64, height: f64) {
    if let Some(w) = app.get_webview_window("ctx") {
        let _ = w.set_size(tauri::LogicalSize::new(width.max(120.0), height.max(80.0)));
    }
}

#[tauri::command]
fn close_ctx(app: tauri::AppHandle) -> bool {
    if let Some(win) = app.get_webview_window("ctx") {
        let _ = win.hide();
        return true;
    }
    false
}

#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
}

/// 子页尺寸变化时调整主菜单窗口（保持左上角不动）
#[tauri::command]
fn resize_menu(app: tauri::AppHandle, width: f64, height: f64) {
    let w = width.max(720.0);
    let h = height.max(380.0);
    if let Some(win) = app.get_webview_window("menu") {
        let r = win.set_size(tauri::LogicalSize::new(w, h));
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(tmp_dir().join("resize-menu.log"))
        {
            use std::io::Write;
            let _ = writeln!(f, "resize_menu -> {}x{} : {:?}", w, h, r.is_ok());
        }
    }
}
/// Update orb color from HSL, and push to Node through the pipe.
#[tauri::command]
fn set_hsl(app: tauri::AppHandle, h: f64, s: f64, l: f64, base: Option<bool>) {
    if let Some(orb) = app.get_webview_window("orb") {
        let js = format!("window.applyHSL && window.applyHSL({h}, {s}, {l});");
        let _ = orb.eval(&js);
    }
    let is_base = base.unwrap_or(false);
    let payload = format!("{{\"h\":{h},\"s\":{s},\"l\":{l},\"base\":{is_base}}}");
    // base=true：这是性格/搭话度决定的 HSL 基准，直接落盘（不依赖管道时序）
    if is_base {
        let dir = data_dir().join("ui-state");
        let _ = std::fs::create_dir_all(&dir);
        let body = format!("{{\"h\":{h},\"s\":{s},\"l\":{l}}}");
        let _ = std::fs::write(dir.join("hsl-base.json"), body);
    }
    let _ = bridge::send_frame(
        bridge::T_CMD,
        &format!("{{\"cmd\":\"set_hsl\",\"data\":{payload}}}"),
    );
}

/// Resize orb window and scale inner sphere.
#[tauri::command]
fn set_orb_scale(app: tauri::AppHandle, scale: f64) {
    let s = scale.clamp(0.5, 2.0);
    if let Some(orb) = app.get_webview_window("orb") {
        let size = (200.0 * s).round();
        let _ = orb.set_size(tauri::LogicalSize::new(size, size));
        let js = format!("window.setOrbScale && window.setOrbScale({s});");
        let _ = orb.eval(&js);
    }
    let _ = bridge::send_frame(
        bridge::T_CMD,
        &format!("{{\"cmd\":\"set_orb_scale\",\"data\":{{\"scale\":{s}}}}}"),
    );
}


/// 对话发送（暂存到 .tmp/chat.log，等接入插件）
#[cfg_attr(mobile, tauri::mobile_entry_point)]
// ── 单实例：用命名互斥量保证只跑一个 HCEM ──
#[cfg(windows)]
fn acquire_single_instance() -> bool {
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn CreateMutexW(lpMutexAttributes: *const std::ffi::c_void, bInitialOwner: i32, lpName: *const u16) -> *mut std::ffi::c_void;
        fn GetLastError() -> u32;
    }
    // Local 只在本用户会话内唯一（不需要管理员权限）
    let name: Vec<u16> = "Local\\HCEM_Desktop_SingleInstance\0".encode_utf16().collect();
    unsafe {
        let h = CreateMutexW(std::ptr::null(), 0, name.as_ptr());
        let err = GetLastError();
        // ERROR_ALREADY_EXISTS = 183
        if h.is_null() || err == 183 {
            return false;
        }
    }
    true
}

#[cfg(not(windows))]
fn acquire_single_instance() -> bool {
    true
}


/// 杀掉本应用残留的 WebView2 子进程（按 user-data-dir 精确匹配，不碰别的应用）
/// 页面埋点：记录点了什么（排查「点了没反应」时看 .tmp\click.log）
#[tauri::command]
fn dbg_click(what: String) {
    use std::io::Write;
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(tmp_dir().join("click.log"))
    {
        let ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        let _ = writeln!(f, "{} page:{}", ms, what);
    }
}

/// 取悬浮球所在显示器的信息（双屏下比 primary_monitor 可靠）
fn app2_monitor(app: &tauri::AppHandle) -> Option<tauri::Monitor> {
    let orb = app.get_webview_window("orb")?;
    orb.current_monitor().ok().flatten()
}
/// 往 <HCEM_HOME>\.tmp\<name> 追加一行带毫秒时间戳的日志（排查按钮/命令用）
fn dlog_tmp(name: &str, msg: &str) {
    use std::io::Write;
    let path = tmp_dir().join(&name);
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        let _ = writeln!(f, "{} {}", ms, msg);
    }
}
/// 启动时清掉 WebView2 的 HTTP 缓存。
/// Tauri 的资源协议会被 WebView2 缓存，改了 index.html/菜单页却还在跑旧页面
/// —— 表现就是「埋点日志一条都没有」。这里每次启动都清一遍，代价只有几十毫秒。
fn clear_webview_cache() {
    let base = tauri_data_dir().to_string_lossy().to_string();
    for w in ["orb", "ctx", "menu"] {
        for sub in ["Default\\Cache", "Default\\Code Cache", "Default\\GPUCache"] {
            let p = format!("{}\\{}\\EBWebView\\{}", base, w, sub);
            let _ = std::fs::remove_dir_all(&p);
        }
    }
}
fn kill_own_webviews() {
    let script = "Get-CimInstance Win32_Process -Filter \"Name='msedgewebview2.exe'\" | Where-Object { $_.CommandLine -like '*tauri-data*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }";
    let _ = std::process::Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status();
}
pub fn run() {
    // ── 单实例锁：已有实例就直接退出 ──
    if !acquire_single_instance() {
        eprintln!("[hcem] 已有实例在运行，本次启动退出");
        std::process::exit(0);
    }

    // 上一个实例如果是被强杀（任务管理器 / Stop-Process）的，它拉起的
    // WebView2 子进程不会跟着退出，会越积越多（实测积到 30 个，约 1.8GB）。
    // 这里在创建任何窗口**之前**先清一遍：按 user-data-dir 精确匹配，
    // 只杀我们自己的（<HCEM_HOME>\.tauri-data\...），不碰 Windows/其它应用的 webview2。
    kill_own_webviews();
    clear_webview_cache();

    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            open_menu,
            close_menu,
            take_pending_page,
            set_orb_visible,
            open_ctx,
            close_ctx,
            resize_ctx,
            quit_app,
            resize_menu,
            set_hsl,
            dbg_click,
            set_orb_scale,
            list_sessions,
            set_mods,
            get_enabled,
            set_enabled,
            read_persona,
            write_persona,
            read_user_card,
            write_user_card,
            ui_cmd,
            voice_start,
            voice_end,
            voice_cancel,
            call_start,
            call_stop,
            call_status,
            wake_services,
            check_services,
            import_memory,
            open_data_dir,
            append_imported
        ])
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            // 启动命名管道客户端（心跳 / 后续业务）
            // 启动时清理过期日志（保留 7 天）并记一条启动日志
            logging::cleanup();
            logging::log("INFO", "app", "HCEM 启动");

            bridge::start(app.handle().clone());

            // 系统托盘不可用（系统级 Shell_NotifyIcon 返回 E_FAIL），已放弃托盘方案


            // WebView2 数据目录放到可写位置（避免 C 盘权限拒绝）
            let orb_data = tauri_data_dir().join("orb");
            let menu_data = tauri_data_dir().join("menu");
            let _ = std::fs::create_dir_all(&orb_data);
            let _ = std::fs::create_dir_all(&menu_data);

            // ---------- 悬浮球 ----------
            // 【悬浮球硬约束】（等价于 tauri.conf.json 的 windows 配置）：
            //   decorations(false)  无边框
            //   transparent(true)   背景全透明（WebView2 透明合成）
            //   always_on_top(true) 置顶
            //   skip_taskbar(true)  不占任务栏
            //   shadow(false)       无系统阴影（否则透明窗口会有方块边）
            let orb = tauri::WebviewWindowBuilder::new(
                app,
                "orb",
                tauri::WebviewUrl::App("index.html".into()),
            )
            .title("HCEM")
            .inner_size(200.0, 200.0)
            .data_directory(orb_data.clone())
            .icon(tauri::include_image!("icons/128x128@2x.png"))?
            .on_page_load(|_w, p| {
                use std::io::Write;
                let line = format!("{:?} {}\n", p.event(), p.url());
                if let Ok(mut f) = std::fs::OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(tmp_dir().join("pageload.log"))
                {
                    let _ = f.write_all(line.as_bytes());
                }
            })
            .resizable(false)
            .maximizable(false)
            .decorations(false)
            .transparent(true)
            .always_on_top(true)
            .skip_taskbar(true)
            .shadow(false)
            .visible(false)
            .build();

            match orb {
                Ok(w) => {
                    // 放到主屏右下角（按物理像素计算，避开任务栏）
                    if let Ok(Some(monitor)) = w.primary_monitor() {
                        let size = monitor.size();
                        let pos = monitor.position();
                        let scale = monitor.scale_factor();
                        let wsize = w.outer_size().unwrap_or(tauri::PhysicalSize::new(200, 200));
                        let x = pos.x + size.width as i32 - wsize.width as i32 - 40;
                        let y = pos.y + size.height as i32 - wsize.height as i32 - 100;
                        let _ = w.set_position(tauri::PhysicalPosition::new(x, y));
                        if let Ok(mut f) = std::fs::OpenOptions::new()
                            .create(true)
                            .append(true)
                            .open(tmp_dir().join("orb-place.log"))
                        {
                            use std::io::Write;
                            let _ = writeln!(
                                f,
                                "monitor={:?} pos=({}, {}) size={}x{} scale={} wsize={}x{} -> ({}, {})",
                                monitor.name(), pos.x, pos.y, size.width, size.height, scale,
                                wsize.width, wsize.height, x, y
                            );
                        }
                    }
                    let _ = w.show();
                }
                Err(e) => eprintln!("[hcem] create orb window failed: {e}"),
            }

            // ---------- 快捷菜单（悬浮球右键）----------
            // 必须在启动时就建好：按需创建 + 立刻 show() 会和窗口初始化打架，
            // 表现就是「右键点了没反应」（实测：窗口建出来了但一直不显示）。
            let ctx_data2 = tauri_data_dir().join("ctx");
            let _ = std::fs::create_dir_all(&ctx_data2);
            let ctx_win = tauri::WebviewWindowBuilder::new(
                app,
                "ctx",
                tauri::WebviewUrl::App("ctx.html".into()),
            )
            .title("HCEM")
            .inner_size(120.0, 240.0)
            .data_directory(ctx_data2)
            .icon(tauri::include_image!("icons/128x128@2x.png"))?
            .resizable(false)
            .maximizable(false)
            .decorations(false)
            .transparent(true)
            .always_on_top(true)
            .skip_taskbar(true)
            .shadow(false)
            .maximizable(false)
            .visible(false)
            .build();

            if let Err(e) = ctx_win {
                eprintln!("[hcem] create ctx window failed: {e}");
            }

            // ---------- 主菜单（隐藏，点击悬浮球时显示）----------
            let (mw0, mh0) = load_menu_size();
            let menu = tauri::WebviewWindowBuilder::new(
                app,
                "menu",
                tauri::WebviewUrl::App("menu.html".into()),
            )
            .title("HCEM")
            .inner_size(mw0, mh0)
            .min_inner_size(640.0, 460.0)
            .data_directory(menu_data.clone())
            .icon(tauri::include_image!("icons/128x128@2x.png"))?
            .resizable(true)
            .maximizable(false)
            .decorations(false)
            .transparent(true)
            .always_on_top(true)
            .skip_taskbar(true)
            .shadow(false)
            .visible(false)
            .build();

            match menu {
                Ok(w) => {
                    // 创建后立刻应用「上次用户拖动的尺寸」
                    let _ = w.set_min_size(Some(tauri::LogicalSize::new(640.0, 460.0)));
                    let _ = w.set_size(tauri::LogicalSize::new(mw0, mh0));
                    let _w2 = w.clone();
                    w.on_window_event(move |e| {
                        if let tauri::WindowEvent::Resized(size) = e {
                            let scale = _w2.scale_factor().unwrap_or(1.0);
                            let lw = (size.width as f64 / scale).round();
                            let lh = (size.height as f64 / scale).round();
                            // 和 load_menu_size 的范围保持一致，否则拖完下次不记得
                            if lw >= 640.0 && lh >= 460.0 && lw <= 1800.0 && lh <= 1400.0 {
                                let _ = std::fs::write(menu_size_file(), format!("{}x{}", lw, lh));
                            }
                        }
                    });
                    // 居中到**悬浮球所在的那块屏**，而不是 primary_monitor()。
                    // 双屏时 primary 可能是另一块屏，菜单就会跑到屏幕外（实测 x=2552）。
                    let mon = app
                        .get_webview_window("orb")
                        .and_then(|o| o.current_monitor().ok().flatten())
                        .or_else(|| w.primary_monitor().ok().flatten());
                    if let Some(monitor) = mon {
                        let size = monitor.size();
                        let pos = monitor.position();
                        // 按窗口「实际尺寸」居中，别用写死的 980x720（尺寸可变了）
                        let wsize = w.outer_size().unwrap_or(tauri::PhysicalSize::new(980, 720));
                        let x = pos.x + ((size.width as i32 - wsize.width as i32) / 2).max(20);
                        let y = pos.y + ((size.height as i32 - wsize.height as i32) / 2).max(20);
                        let _ = w.set_position(tauri::PhysicalPosition::new(x, y));
                    }
                }
                Err(e) => eprintln!("[hcem] create menu window failed: {e}"),
            }

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_handle, event| {
            // 正常退出时把 WebView2 一起收干净：Tauri 自己会关窗口，
            // 但强杀路径留下的孤儿要在这里兜一次（进程一退就管不到了）。
            if let tauri::RunEvent::Exit = event {
                kill_own_webviews();
            }
        });
}

#[derive(serde::Serialize, Clone)]
struct CheckItem {
    name: String,
    /// on = 运行中/就绪且已启用；idle = 就绪但开关未开；off = 不可用
    state: String,
    detail: String,
}

#[derive(serde::Serialize, Clone)]
struct ImportResult {
    name: String,
    size: u64,
    ok: bool,
    detail: String,
}

fn port_open(port: u16) -> bool {
    use std::net::{SocketAddr, TcpStream};
    let addr: SocketAddr = ([127, 0, 0, 1], port).into();
    TcpStream::connect_timeout(&addr, std::time::Duration::from_millis(300)).is_ok()
}

/// 唤醒模型服务（空闲休眠会停掉它们，这里按需拉起）
#[tauri::command]
fn wake_services() {
    let _ = bridge::send_frame(bridge::T_CMD, "{\"cmd\":\"wake_services\",\"data\":{}}");
}

/// 读 mods.json 里的开关状态（只有 UI 侧关心，这里用来判断"功能是否启用"）
fn mods_flags() -> serde_json::Value {
    let path = data_dir().join("ui-state").join("mods.json");
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .unwrap_or(serde_json::Value::Null)
}

/// 某个扁平开关是否打开（兼容 {"desk-watch":true} 与 {"desktop":{"enabled":true}} 两种写法）
fn flag_on(mods: &serde_json::Value, key: &str) -> bool {
    if let Some(v) = mods.get(key).and_then(|v| v.as_bool()) {
        return v;
    }
    // 扁平键 → 嵌套键
    let nested = match key {
        "desk-watch" => "desktop",
        "video-watch" => "video",
        "audio-watch" => "audio",
        "voice-in" => "voiceIn",
        "voice-out" => "voiceOut",
        "local-route" => "localRoute",
        other => other,
    };
    mods.get(nested)
        .and_then(|v| v.get("enabled"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
}

#[tauri::command]
fn check_services() -> Vec<CheckItem> {
    // 埋点：检测按钮"没反应"时，看这个文件判断是命令没进来还是卡在某项探测
    dlog_tmp("check.log", "check_services start");
    let t0 = std::time::Instant::now();
    let mods = mods_flags();
    // 视听/语音相关能力是否被至少一个开关启用
    let sensing_on = flag_on(&mods, "desk-watch")
        || flag_on(&mods, "video-watch")
        || flag_on(&mods, "audio-watch");
    let voice_on = flag_on(&mods, "voice-in") || flag_on(&mods, "voice-out");

    // 三态：on=运行中/就绪且已启用 / idle=就绪但开关没开 / off=不可用
    let mut items = Vec::new();
    let port_state = |port: u16| {
        if port_open(port) {
            "on"
        } else {
            "off"
        }
    };
    items.push(CheckItem {
        name: "视觉模型".into(),
        state: port_state(8091).into(),
        detail: "Qwen2.5-VL-3B · :8091".into(),
    });
    items.push(CheckItem {
        name: "分流模型".into(),
        state: port_state(8093).into(),
        detail: "Qwen3-1.7B · :8093".into(),
    });
    items.push(CheckItem {
        name: "向量模型".into(),
        state: port_state(8094).into(),
        detail: "Qwen3-Embedding · :8094".into(),
    });
    items.push(CheckItem {
        name: "情绪模型".into(),
        state: port_state(8098).into(),
        detail: "OmniDimen-4B · :8098".into(),
    });

    // 文件型能力：装了 ≠ 在用。开关没开就报 idle，别让人误以为已经在跑。
    let asr_exe = exe_dir().join("models").join("CrispASR-v0.8.53-win-x64-cuda").join("crispasr.exe");
    let asr_model = exe_dir().join("models").join("qwen3-asr-crisp").join("qwen3-asr-0.6b-q8_0.gguf");
    let asr_ok = asr_exe.exists() && asr_model.exists();
    items.push(CheckItem {
        name: "语音识别".into(),
        state: if !asr_ok {
            "off"
        } else if sensing_on || voice_on {
            "on"
        } else {
            "idle"
        }
        .into(),
        detail: "Qwen3-ASR · CrispASR".into(),
    });

    let py_venv = exe_dir().join("python-venv").join("Scripts").join("python.exe");
    let py_ok = py_venv.exists();
    items.push(CheckItem {
        name: "Python 运行时".into(),
        state: if !py_ok {
            "off"
        } else if sensing_on || voice_on {
            "on"
        } else {
            "idle"
        }
        .into(),
        detail: "录音 / 情感 / 声纹（独立 venv）".into(),
    });

    items.push(CheckItem {
        name: "语音通道".into(),
        state: port_state(8097).into(),
        detail: "插件事件与通话控制 · :8097".into(),
    });

    let (state, detail) = match std::process::Command::new("nvidia-smi")
        .args(["--query-gpu=memory.used,memory.total", "--format=csv,noheader,nounits"])
        .output()
    {
        Ok(o) => {
            let s = String::from_utf8_lossy(&o.stdout).trim().to_string();
            if s.is_empty() {
                ("off".to_string(), "nvidia-smi 无输出".to_string())
            } else {
                // nvidia-smi 给的是 "已用, 总量"
                let parts: Vec<&str> = s.split(',').map(|x| x.trim()).collect();
                let text = if parts.len() == 2 {
                    format!("{} / {} MiB", parts[0], parts[1])
                } else {
                    format!("{} MiB", s)
                };
                ("on".to_string(), text)
            }
        }
        Err(_) => ("off".to_string(), "nvidia-smi 不可用".to_string()),
    };
    items.push(CheckItem {
        name: "显存".into(),
        state,
        detail,
    });
    dlog_tmp("check.log", &format!("check_services done {} items in {}ms", items.len(), t0.elapsed().as_millis()));
    items
}

fn menu_size_file() -> std::path::PathBuf {
    tmp_dir().join("menu-size.txt")
}

/// 读取上次保存的菜单窗口尺寸（逻辑像素）
/// 下限放到 720x520：用户要求能随意拖小，挤一点也比缩不动强
fn load_menu_size() -> (f64, f64) {
    // 记住用户拖动后的窗口尺寸（逻辑像素）
    if let Ok(s) = std::fs::read_to_string(menu_size_file()) {
        let parts: Vec<f64> = s.trim().split('x').filter_map(|v| v.parse().ok()).collect();
        if parts.len() == 2 && parts[0] >= 640.0 && parts[0] <= 1800.0 && parts[1] >= 460.0 && parts[1] <= 1400.0 {
            return (parts[0], parts[1]);
        }
    }
    (900.0, 660.0)
}

fn reincarnation_dir() -> std::path::PathBuf {
    data_dir().join("reincarnation")
}

fn copy_into_reincarnation(paths: &[std::path::PathBuf]) -> Vec<ImportResult> {
    let dir = reincarnation_dir();
    let _ = std::fs::create_dir_all(&dir);
    let mut out = Vec::new();
    for p in paths {
        let name = p
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
        let mut dest = dir.join(&name);
        if dest.exists() {
            let stem = p
                .file_stem()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_default();
            let ext = p
                .extension()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_default();
            let ts = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0);
            dest = if ext.is_empty() {
                dir.join(format!("{stem}-{ts}"))
            } else {
                dir.join(format!("{stem}-{ts}.{ext}"))
            };
        }
        match std::fs::copy(p, &dest) {
            Ok(size) => out.push(ImportResult {
                name,
                size,
                ok: true,
                detail: dest.to_string_lossy().to_string(),
            }),
            Err(e) => out.push(ImportResult {
                name,
                size: 0,
                ok: false,
                detail: e.to_string(),
            }),
        }
    }
    out
}

#[tauri::command]
fn import_memory(paths: Vec<String>) -> Vec<ImportResult> {
    let list: Vec<std::path::PathBuf> = paths.into_iter().map(std::path::PathBuf::from).collect();
    copy_into_reincarnation(&list)
}

#[tauri::command]
fn append_imported(files: Vec<String>) {
    use std::io::Write;
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(tmp_dir().join("imported.log"))
    {
        for name in files {
            let _ = writeln!(f, "{}", name);
        }
    }
}
#[tauri::command]
fn open_data_dir() {
    let dir = data_dir();
    let _ = std::fs::create_dir_all(&dir);
    // windowsHide 保证不弹控制台窗口
    use std::os::windows::process::CommandExt;
    let _ = std::process::Command::new("explorer.exe")
        .arg(&dir)
        .creation_flags(0x0800_0000)
        .spawn();
}
/// 读取 HCEM 模式会话列表（由插件写入 data/ui-state/sessions.json）
/// 列出 DSH 里所有的 HCEM 会话（直接读 DSH 的投影缓存，天然跟着 DSH 同步：
/// DSH 删了会话 → 缓存文件消失 → 这里也就没有了，不需要额外维护）
#[tauri::command]
fn list_sessions() -> Vec<serde_json::Value> {
    let mut out: Vec<serde_json::Value> = Vec::new();

    // DSH 的会话投影缓存目录
    let home = match std::env::var("USERPROFILE") {
        Ok(v) => v,
        Err(_) => return out,
    };
    let dir = std::path::PathBuf::from(home)
        .join(".dsh")
        .join("storages")
        .join("session_projcache")
        .join("sessions");

    let entries = match std::fs::read_dir(&dir) {
        Ok(e) => e,
        Err(_) => return out,
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        let txt = match std::fs::read_to_string(&path) {
            Ok(s) => s,
            Err(_) => continue,
        };
        let v: serde_json::Value = match serde_json::from_str(&txt) {
            Ok(x) => x,
            Err(_) => continue,
        };

        // 只留 HCEM 模式（agentPreset.val == "hcem"）
        let preset = v
            .pointer("/record/rows/agentPreset/val")
            .and_then(|x| x.as_str())
            .unwrap_or("");
        if preset != "hcem" {
            continue;
        }

        // 会话 id 从文件名取（session-<uuid>.json）
        let id = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .trim_start_matches("session-")
            .to_string();
        if id.is_empty() {
            continue;
        }

        let title = v
            .pointer("/record/rows/title/val")
            .and_then(|x| x.as_str())
            .filter(|s| !s.is_empty())
            .unwrap_or("未命名会话")
            .to_string();
        let cwd = v
            .pointer("/record/identity/cwd")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string();
        let created = v
            .pointer("/record/identity/createdAt")
            .and_then(|x| x.as_i64())
            .unwrap_or(0);
        let mtime = std::fs::metadata(&path)
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);

        out.push(serde_json::json!({
            "id": id,
            "title": title,
            "cwd": cwd,
            "createdAt": created,
            "lastActive": mtime,
        }));
    }

    // 最近活动的排前面
    out.sort_by(|a, b| {
        let am = a.get("lastActive").and_then(|x| x.as_i64()).unwrap_or(0);
        let bm = b.get("lastActive").and_then(|x| x.as_i64()).unwrap_or(0);
        bm.cmp(&am)
    });

    out
}
/// 多模态开关状态 → 存内存 + 通过管道推给 Node
/// 读角色卡（直接读插件用的那个文件，保证和 AI 看到的是同一份）
#[tauri::command]
fn read_persona() -> String {
    let p = data_dir().join("persona").join("persona.md");
    std::fs::read_to_string(p).unwrap_or_default()
}

/// 写角色卡（写同一个文件，插件下次组装提示词就会读到）
#[tauri::command]
fn write_persona(text: String) -> bool {
    let dir = data_dir().join("persona");
    let _ = std::fs::create_dir_all(&dir);
    let p = dir.join("persona.md");
    std::fs::write(p, text).is_ok()
}

/// 读用户卡
#[tauri::command]
fn read_user_card() -> String {
    let p = data_dir().join("persona").join("用户.md");
    std::fs::read_to_string(p).unwrap_or_default()
}

/// 写用户卡
#[tauri::command]
fn write_user_card(text: String) -> bool {
    let dir = data_dir().join("persona");
    let _ = std::fs::create_dir_all(&dir);
    let p = dir.join("用户.md");
    std::fs::write(p, text).is_ok()
}

/// 读插件总开关（data/settings.json 的 enabled）
#[tauri::command]
fn get_enabled() -> bool {
    let p = data_dir().join("settings.json");
    match std::fs::read_to_string(p) {
        Ok(txt) => match serde_json::from_str::<serde_json::Value>(txt.trim_start_matches('\u{FEFF}')) {
            Ok(v) => v.get("enabled").and_then(|x| x.as_bool()).unwrap_or(false),
            Err(_) => false,
        },
        Err(_) => false,
    }
}

/// 写插件总开关（写文件即可：插件侧每次组装提示词都重新读 settings.json）
#[tauri::command]
fn set_enabled(enabled: bool) -> bool {
    let p = data_dir().join("settings.json");
    let mut v: serde_json::Value = match std::fs::read_to_string(&p) {
        Ok(txt) => serde_json::from_str(txt.trim_start_matches('\u{FEFF}')).unwrap_or(serde_json::json!({})),
        Err(_) => serde_json::json!({}),
    };
    if !v.is_object() {
        v = serde_json::json!({});
    }
    if let Some(obj) = v.as_object_mut() {
        obj.insert("enabled".to_string(), serde_json::Value::Bool(enabled));
    }
    match serde_json::to_string_pretty(&v) {
        Ok(s) => std::fs::write(&p, s + "\n").is_ok(),
        Err(_) => false,
    }
}

#[tauri::command]
fn set_mods(mods: serde_json::Value) {
    let s = serde_json::to_string(&mods).unwrap_or_default();
    let _ = bridge::send_frame(bridge::T_CMD, &format!("{{\"cmd\":\"set_mods\",\"data\":{s}}}"));
}
/// 通用 UI 命令：把界面上的一切操作转发给插件（命名管道 CMD）
#[tauri::command]
fn ui_cmd(cmd: String, data: serde_json::Value) {
    let payload = serde_json::json!({ "cmd": cmd, "data": data });
    let _ = bridge::send_frame(bridge::T_CMD, &payload.to_string());
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(tmp_dir().join("ui-cmd-recv.log"))
    {
        use std::io::Write;
        let _ = writeln!(f, "{}", payload);
    }
}
/// 长按开始语音输入（转发给插件侧）
#[tauri::command]
fn voice_start() {
    let _ = bridge::send_frame(
        bridge::T_CMD,
        "{\"cmd\":\"voice_start\",\"data\":{}}",
    );
}

/// 取消语音输入（拖拽/短按时调用，丢掉这次录音）
#[tauri::command]
fn voice_cancel() {
    let _ = bridge::send_frame(bridge::T_CMD, "{\"cmd\":\"voice_cancel\",\"data\":{}}");
}

/// 松开结束语音输入
#[tauri::command]
fn voice_end() {
    let _ = bridge::send_frame(
        bridge::T_CMD,
        "{\"cmd\":\"voice_end\",\"data\":{}}",
    );
}

/// 开始语音通话（一直听，听到就答，用户开口打断播报）
#[tauri::command]
fn call_start() {
    let _ = bridge::send_frame(bridge::T_CMD, "{\"cmd\":\"call_start\",\"data\":{}}");
}

/// 结束语音通话
#[tauri::command]
fn call_stop() {
    let _ = bridge::send_frame(bridge::T_CMD, "{\"cmd\":\"call_stop\",\"data\":{}}");
}

/// 查询通话状态
#[tauri::command]
fn call_status() {
    let _ = bridge::send_frame(bridge::T_CMD, "{\"cmd\":\"call_status\",\"data\":{}}");
}
