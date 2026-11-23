//! 按进程采集系统声音（Windows 进程回环）
//!
//! 用途：看视频时只抓「播放器/浏览器」这个进程的声音，
//! 不混入用户的说话声、通知音、其它程序的声音。
//!
//! 用法：
//!   process-capture.exe <进程ID> <输出.wav> <秒数>
//!
//! 原理（Windows 10 2004+）：
//!   ActivateAudioInterfaceAsync 激活 "VAD\Process_Loopback" 虚拟设备，
//!   带 AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK 参数指定目标进程树，
//!   然后按共享模式初始化 IAudioClient（LOOPBACK 标志），循环读帧写成 16k 单声道 wav。

use std::fs::File;
use std::io::{BufWriter, Write};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use windows::core::{implement, Interface, HSTRING, PCWSTR};
use windows::Win32::Foundation::{E_FAIL, HANDLE, S_OK};
use windows::Win32::Media::Audio::{
    ActivateAudioInterfaceAsync, IActivateAudioInterfaceAsyncOperation,
    IActivateAudioInterfaceCompletionHandler, IActivateAudioInterfaceCompletionHandler_Impl,
    IAudioCaptureClient, IAudioClient, AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK,
    AUDIOCLIENT_ACTIVATION_PARAMS, AUDIOCLIENT_ACTIVATION_PARAMS_0,
    AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK, AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS,
    PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE, WAVEFORMATEX,
};
use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};
use windows::Win32::System::Com::StructuredStorage::PROPVARIANT;
use windows::Win32::System::Variant::VT_BLOB;
use windows::Win32::System::Threading::GetCurrentProcessId;

/// 目标采样率（识别模型要 16k 单声道）
const TARGET_RATE: u32 = 16000;

#[implement(IActivateAudioInterfaceCompletionHandler)]
struct CompletionHandler {
    tx: mpsc::Sender<Result<IAudioClient, String>>,
}

impl IActivateAudioInterfaceCompletionHandler_Impl for CompletionHandler_Impl {
    fn ActivateCompleted(
        &self,
        operation: windows::core::Ref<IActivateAudioInterfaceAsyncOperation>,
    ) -> windows::core::Result<()> {
        let op = operation.ok()?;
        unsafe {
            let mut hr: windows::core::HRESULT = E_FAIL;
            let mut iface: Option<windows::core::IUnknown> = None;
            let _ = op.GetActivateResult(&mut hr, &mut iface);
            if hr != S_OK {
                let _ = self.tx.send(Err(format!("激活失败 hr=0x{:08X}", hr.0)));
                return Ok(());
            }
            match iface.and_then(|u| u.cast::<IAudioClient>().ok()) {
                Some(client) => {
                    let _ = self.tx.send(Ok(client));
                }
                None => {
                    let _ = self.tx.send(Err("拿不到音频客户端".into()));
                }
            }
        }
        Ok(())
    }
}

/// 写一段 PCM 到 wav
fn write_wav(path: &str, samples: &[i16], rate: u32) -> std::io::Result<()> {
    let mut f = BufWriter::new(File::create(path)?);
    let data_len = (samples.len() * 2) as u32;
    let riff_len = 36 + data_len;
    f.write_all(b"RIFF")?;
    f.write_all(&riff_len.to_le_bytes())?;
    f.write_all(b"WAVEfmt ")?;
    f.write_all(&16u32.to_le_bytes())?;
    f.write_all(&1u16.to_le_bytes())?; // PCM
    f.write_all(&1u16.to_le_bytes())?; // 单声道
    f.write_all(&rate.to_le_bytes())?;
    f.write_all(&(rate * 2).to_le_bytes())?; // 字节率
    f.write_all(&2u16.to_le_bytes())?; // 块对齐
    f.write_all(&16u16.to_le_bytes())?; // 位深
    f.write_all(b"data")?;
    f.write_all(&data_len.to_le_bytes())?;
    for s in samples {
        f.write_all(&s.to_le_bytes())?;
    }
    f.flush()?;
    Ok(())
}

/// 简单的线性重采样到 16k（够用即可）
fn resample(input: &[f32], src_rate: u32) -> Vec<i16> {
    if input.is_empty() || src_rate == 0 {
        return Vec::new();
    }
    let ratio = src_rate as f64 / TARGET_RATE as f64;
    let out_len = (input.len() as f64 / ratio) as usize;
    let mut out = Vec::with_capacity(out_len);
    for i in 0..out_len {
        let pos = i as f64 * ratio;
        let idx = pos as usize;
        let frac = pos - idx as f64;
        let a = input.get(idx).copied().unwrap_or(0.0) as f64;
        let b = input.get(idx + 1).copied().unwrap_or(a as f32) as f64;
        let v = a + (b - a) * frac;
        out.push((v.clamp(-1.0, 1.0) * 32767.0) as i16);
    }
    out
}

fn capture(pid: u32, seconds: f32) -> Result<Vec<i16>, String> {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);

        let (tx, rx) = mpsc::channel();
        let handler: IActivateAudioInterfaceCompletionHandler = CompletionHandler { tx }.into();

        let lp: AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS = AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS {
            TargetProcessId: pid,
            ProcessLoopbackMode: PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE,
        };
        let params = AUDIOCLIENT_ACTIVATION_PARAMS {
            ActivationType: AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
            Anonymous: AUDIOCLIENT_ACTIVATION_PARAMS_0 {
                ProcessLoopbackParams: lp,
            },
        };

        // 进程回环的虚拟设备路径（固定字符串）
        let device_id = HSTRING::from("VAD\\Process_Loopback");
        // windows crate 的签名要求 PROPVARIANT，这里把参数塞进 VT_BLOB
        let mut prop = PROPVARIANT::default();
        prop.vt = VT_BLOB;
        prop.Anonymous.blob.cbSize = std::mem::size_of::<AUDIOCLIENT_ACTIVATION_PARAMS>() as u32;
        prop.Anonymous.blob.pBlobData = &params as *const _ as *mut u8;
        let op: IActivateAudioInterfaceAsyncOperation = ActivateAudioInterfaceAsync(
            PCWSTR(device_id.as_ptr()),
            &IAudioClient::IID,
            Some(&prop),
            &handler,
        )
        .map_err(|e| format!("ActivateAudioInterfaceAsync 失败: {e}"))?;
        let _ = op;

        let client = rx
            .recv_timeout(Duration::from_secs(10))
            .map_err(|_| "等待激活超时".to_string())??;

        // 目标格式：48k 立体声 float（多数设备默认），之后重采样
        let src_rate: u32 = 48000;
        let channels: u16 = 2;
        let block_align = channels * 4;
        let format = WAVEFORMATEX {
            wFormatTag: 3, // IEEE float
            nChannels: channels,
            nSamplesPerSec: src_rate,
            nAvgBytesPerSec: src_rate * block_align as u32,
            nBlockAlign: block_align,
            wBitsPerSample: 32,
            cbSize: 0,
        };

        client
            .Initialize(
                AUDCLNT_SHAREMODE_SHARED,
                AUDCLNT_STREAMFLAGS_LOOPBACK,
                10_000_000, // 1s
                0,
                &format,
                None,
            )
            .map_err(|e| format!("初始化失败: {e}"))?;

        let capture_client: IAudioCaptureClient = client
            .GetService()
            .map_err(|e| format!("拿采集客户端失败: {e}"))?;
        client.Start().map_err(|e| format!("启动失败: {e}"))?;

        let deadline = Instant::now() + Duration::from_secs_f32(seconds.max(0.5));
        let mut raw: Vec<f32> = Vec::new();
        let mut packet = 0u32;

        while Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(50));
            loop {
                match capture_client.GetNextPacketSize() {
                    Ok(0) => break,
                    Ok(_) => {}
                    Err(_) => break,
                }
                let mut data: *mut u8 = std::ptr::null_mut();
                let mut frames = 0u32;
                let mut flags = 0u32;
                if capture_client
                    .GetBuffer(&mut data, &mut frames, &mut flags, None, None)
                    .is_err()
                {
                    break;
                }
                if frames > 0 && !data.is_null() {
                    let count = (frames as usize) * (channels as usize);
                    let slice = std::slice::from_raw_parts(data as *const f32, count);
                    raw.extend_from_slice(slice);
                }
                let _ = capture_client.ReleaseBuffer(frames);
                packet += 1;
                if packet > 100000 {
                    break;
                }
            }
        }
        let _ = client.Stop();
        Ok(resample(&raw, src_rate))
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 4 {
        eprintln!("用法: process-capture.exe <进程ID> <输出.wav> <秒数>");
        std::process::exit(2);
    }
    let pid: u32 = args[1].parse().unwrap_or(0);
    let out = args[2].clone();
    let seconds: f32 = args[3].parse().unwrap_or(3.0);
    if pid == 0 {
        eprintln!("进程ID 无效");
        std::process::exit(2);
    }
    let _self_pid = unsafe { GetCurrentProcessId() };

    match capture(pid, seconds) {
        Ok(samples) => match write_wav(&out, &samples, TARGET_RATE) {
            Ok(()) => {
                println!(
                    "ok: {} ({} samples @ {}Hz)",
                    out,
                    samples.len(),
                    TARGET_RATE
                );
            }
            Err(e) => {
                eprintln!("写文件失败: {e}");
                std::process::exit(1);
            }
        },
        Err(e) => {
            eprintln!("采集失败: {e}");
            std::process::exit(1);
        }
    }
}
