"""麦克风录音 → 16kHz 单声道 wav

用法：
  python record_mic.py <输出 wav> [时长秒数=5] [设备序号]
      时长 > 0：录固定秒数后自动结束
      时长 = 0：一直录，直到 stdin 收到一行 "stop"（长按语音用这个）
      时长 = -1：自动断句录音（打电话用这个）——说开始录，静了就停
      时长 = -2：同上，但开头不等待人声，从第一帧就开始（用于接续判断）

  python record_mic.py --list    列出所有输入设备

为什么支持「时长 0 + stdin 控制」：
  之前是每 2 秒切一段、拼起来，**拼接点会丢几十毫秒**，用户听感是"吃字"。
  现在改成一次连续录音，松手时发 "stop"，同一段内没有断点。

为什么有「自动断句」（-1）：
  打电话时没人按按钮。这个模式自己判断「说完了」：
  先量噪声底，超过 3 倍噪声底算开口，之后持续静音 700ms 就收尾。
  同时保留开口前 300ms 的**预滚**——不然第一个字会被切掉（老问题）。

和 record.py 的区别：
  · record.py      录 WASAPI **loopback**（电脑正在播放的声音）→ 给音频监听用
  · record_mic.py  录**麦克风**（用户说话）→ 给长按语音输入 / 通话用

性能：设备选择结果缓存在 .mic-device.json（第一次遍历约 700ms，之后约 1ms）。
  这个缓存很关键——长按时启动慢会直接吞掉说话开头。
"""

import json
import os
import select
import sys
import threading
import wave

import numpy as np
import pyaudiowpatch as pyaudio

CHUNK = 1024
TARGET_SR = 16000

# ── 自动断句参数（打电话用）──────────────────────────────
PREROLL_MS = 300          # 开口前的预滚，保住第一个字
SILENCE_MS = 1400         # 连续静音多久算说完。700ms 会在换气处切断句子，标点也跟着碎
MIN_SPEECH_MS = 250       # 至少说了这么久才算一句话（否则当咳嗽/碰麦）
MAX_UTTERANCE_SEC = 30    # 一句话最多录这么久，防跑飞
MAX_WAIT_SEC = 12         # 等开口最多等这么久，没人说话就放弃
VOICE_FACTOR = 3.0        # 收尾判据：噪声底的多少倍以下算静音
MIN_THRESHOLD = 0.008     # 绝对下限
START_MAX = 0.03          # 开口判据的上限：宁可早点开，也别被别人说话声估歪了底
SILENCE_RATIO = 0.22      # 收尾判据之二：低于「说话电平」的这个比例算静音
NOISE_WINDOW_SEC = 2.0    # 噪声底用最近 2 秒的低分位数估计
NOISE_PERCENTILE = 15     # 取 15 分位：说话持续时也能摸到停顿处的底
LEVEL_FLOOR = 0.02        # 电平归一化的参考下限
LEVEL_GATE = 0.02         # 软门限：低于这个 RMS 的电平按比例压暗（噪声底不该点亮五条）
LEVEL_GAMMA = 0.65        # 电平曲线：<1 抬高低音量
LEVEL_DECAY = 0.995       # 参考峰值的衰减（每帧约 23ms，半衰约 3.4s）

CACHE = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), '..', '..', '..', 'data', 'voice-input', '.mic-device.json'
)


def is_loopback(d):
    return bool(d.get("isLoopbackDevice", False))


def score_device(d):
    """按名字打分：这台机器上 Realtek 有信号，USB 麦和声音映射器是静音的"""
    name = str(d.get("name", "")).lower()
    s = 0
    if "realtek" in name:
        s += 100
    if "usb" in name:
        s -= 50
    if "麦克风" in name or "microphone" in name:
        s += 30
    if "声音映射器" in name or "sound mapper" in name:
        s -= 80
    if "cable" in name or "virtual" in name:
        s -= 60
    if "主声音捕获" in name:
        s -= 40
    return s


def read_cache():
    try:
        with open(CACHE, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def write_cache(idx, name, sr, ch):
    try:
        os.makedirs(os.path.dirname(CACHE), exist_ok=True)
        with open(CACHE, "w", encoding="utf-8") as f:
            json.dump({"index": idx, "name": name, "sr": sr, "ch": ch}, f, ensure_ascii=False)
    except Exception:
        pass


def try_open(pa, idx, ch, sr):
    return pa.open(
        format=pyaudio.paInt16,
        channels=ch,
        rate=sr,
        input=True,
        input_device_index=idx,
        frames_per_buffer=CHUNK,
    )


def pick_and_open(pa, forced_index=None):
    """返回 (stream, dev)。优先缓存，缓存失效才遍历设备。"""
    if forced_index is not None:
        d = pa.get_device_info_by_index(int(forced_index))
        return try_open(pa, d["index"], int(d["maxInputChannels"]), int(d["defaultSampleRate"])), d

    cached = read_cache()
    if cached and cached.get("index") is not None:
        try:
            idx = int(cached["index"])
            ch = int(cached.get("ch") or 1)
            sr = int(cached.get("sr") or 44100)
            stream = try_open(pa, idx, ch, sr)
            d = pa.get_device_info_by_index(idx)
            return stream, d
        except Exception:
            pass

    candidates = []
    for i in range(pa.get_device_count()):
        d = pa.get_device_info_by_index(i)
        if d.get("maxInputChannels", 0) > 0 and not is_loopback(d):
            candidates.append(d)
    candidates.sort(key=score_device, reverse=True)

    last_err = None
    for d in candidates:
        try:
            idx = d["index"]
            ch = int(d["maxInputChannels"])
            sr = int(d["defaultSampleRate"])
            stream = try_open(pa, idx, ch, sr)
            write_cache(idx, d.get("name", ""), sr, ch)
            return stream, d
        except Exception as e:
            last_err = e
            continue
    raise RuntimeError(f"没有可用的麦克风（最后一个错误: {last_err}）")


def stdin_says_stop():
    """非阻塞检查 stdin 是否收到 stop

    注意：Windows 上 select.select 不支持 stdin 管道，会立刻返回可读，
    导致录音第一轮就结束（实测只录到 0.02 秒）。所以用线程阻塞读。
    """
    try:
        r, _, _ = select.select([sys.stdin], [], [], 0)
        if not r:
            return False
        line = sys.stdin.readline()
        if not line:
            return True
        return line.strip().lower() in ("stop", "q", "quit")
    except Exception:
        return True


def start_stdin_watcher(stop_event, abort_event):
    """后台线程：阻塞读 stdin，收到 stop 就置位 stop_event"""

    def run():
        try:
            while True:
                line = sys.stdin.readline()
                if not line:  # EOF = 父进程没了，也停
                    stop_event.set()
                    return
                low = line.strip().lower()
                if low == "abort":
                    abort_event.set()
                    stop_event.set()
                    return
                if low in ("stop", "q", "quit"):
                    stop_event.set()
                    return
        except Exception:
            stop_event.set()

    t = threading.Thread(target=run, daemon=True)
    t.start()
    return t


def write_wav(out, data, sr_in, ch):
    """把 float32 mono 数据重采样到 16k 并写 wav"""
    if sr_in != TARGET_SR and len(data) > 0:
        t_old = np.linspace(0, 1, len(data), endpoint=False)
        t_new = np.linspace(0, 1, int(len(data) * TARGET_SR / sr_in), endpoint=False)
        data = np.interp(t_new, t_old, data)
    pcm = (data * 32767).astype(np.int16).tobytes()
    with wave.open(out, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(TARGET_SR)
        w.writeframes(pcm)
    return pcm


def list_devices(pa):
    for i in range(pa.get_device_count()):
        d = pa.get_device_info_by_index(i)
        if d.get("maxInputChannels", 0) > 0:
            print(
                f"[{i}] {d.get('name', '?')}  ch={d['maxInputChannels']}  "
                f"sr={int(d['defaultSampleRate'])}  loop={is_loopback(d)}  score={score_device(d)}"
            )


def chunk_rms(frame_bytes):
    """一帧 int16 的 RMS（0~1）"""
    a = np.frombuffer(frame_bytes, dtype=np.int16).astype(np.float32) / 32768.0
    if a.size == 0:
        return 0.0
    return float(np.sqrt(np.mean(a * a)))


def record_endpointed(stream, sr, ch, wait_for_voice=True):
    """自动断句录音。

    状态机：
      wait   → 攒噪声底，等开口
      speak  → 说话中，持续读
      静音累计超过 SILENCE_MS 且已说过 MIN_SPEED_MS → 收尾

    stdout 会实时打三类行（Node 侧解析）：
      start          开口了（打断播报靠这一行，不能等说完）
      lvl <0~1>      实时电平（UI 声波靠它动）
      （结束时由 main 打 ok: / nospeech:）

    返回 (chunks, info)；chunks 是 int16 原始帧列表（含预滚）。
    """
    preroll = int(sr / CHUNK * PREROLL_MS / 1000)
    silence_frames = max(1, int(sr / CHUNK * SILENCE_MS / 1000))
    min_speech_frames = max(1, int(sr / CHUNK * MIN_SPEECH_MS / 1000))
    max_frames = int(sr / CHUNK * MAX_UTTERANCE_SEC)
    max_wait_frames = int(sr / CHUNK * MAX_WAIT_SEC)

    ring = []                 # 预滚缓冲：最近 preroll 帧
    collected = []            # 已确认要保留的帧
    rms_window = []           # 最近 NOISE_WINDOW_SEC 的 RMS，用于估噪声底
    noise_floor = None
    started = False
    speech_frames = 0
    silent_run = 0
    trimmed_ms = 0
    speech_level = 0.0        # 这一段里出现过的最强电平（缓慢衰减）

    window_len = max(12, int(sr / CHUNK * NOISE_WINDOW_SEC))

    def threshold_now():
        """开口判据（宽松）：噪声底 × 2.5，但不超过 START_MAX。
        录音单元常常一开头就是人声，噪声底会被说话声抬高，
        所以这里必须封顶——否则永远开不了口。"""
        if noise_floor is None:
            return START_MAX
        return min(max(noise_floor * 2.5, MIN_THRESHOLD), START_MAX)

    total = 0
    level_clock = 0
    level_peak = 0.0
    while total < max_frames:
        frame = stream.read(CHUNK, exception_on_overflow=False)
        total += 1
        rms = chunk_rms(frame)

        # 实时电平：约每 100ms 一行，给 UI 的声波动画用。
        #
        # 用「相对当前峰值的比例」而不是绝对增益：麦克风增益、说话音量的个体差异太大，
        # 绝对系数会让有些人一直顶满、有些人几乎不动。这里跟踪一个缓慢衰减的峰值，
        # 把这段录音里最响的地方当 1.0，小声自然落下来，动态范围始终用满。
        level_peak = max(rms, level_peak * LEVEL_DECAY)
        level_clock += 1
        if level_clock >= max(1, int(sr / CHUNK / 10)):
            level_clock = 0
            ref = max(level_peak * 0.85, LEVEL_FLOOR)
            # 软门限：纯噪声底会被自适应归一化到中间，看着像"一直在听"。
            # 低于 LEVEL_GATE 的部分按比例压暗，安静时五条应该几乎贴底。
            gate = min(1.0, rms / LEVEL_GATE)
            lvl = gate * min(1.0, (max(0.0, rms) / ref) ** LEVEL_GAMMA)
            print(f"lvl {lvl:.3f}", flush=True)

        # 噪声底：滚动窗口的低分位数。开头就说、全程没停也别怕——
        # 用「中位数」会把说话声当成底，阈值被抬到人声的 3 倍，永远开不了口。
        rms_window.append(rms)
        if len(rms_window) > window_len:
            rms_window.pop(0)
        if len(rms_window) >= 12:
            noise_floor = float(np.percentile(rms_window, NOISE_PERCENTILE))
        need = threshold_now()

        if not started:
            ring.append(frame)
            if len(ring) > preroll:
                ring.pop(0)
            if not wait_for_voice:
                # -2 模式：从第一帧就要，不判开口
                started = True
                collected = list(ring)
                speech_frames = min_speech_frames
                ring.clear()
            elif noise_floor is not None and rms > need:
                started = True
                collected = list(ring)   # 把预滚一起收进来，保住第一个字
                speech_frames = 1
                ring.clear()
                # 立刻上报「开口了」：打断播放要靠这一行，不能等说完
                print("start", flush=True)
            elif total >= max_wait_frames:
                # 等了 12 秒还没人说话：放弃，别傻等
                break
            continue

        collected.append(frame)
        # 说话电平：跟着当前这一段走。收尾判据用它，而不是用噪声底——
        # 全程都在说话的录音单元根本没有静音段可以估底。
        if rms > speech_level:
            speech_level = rms
        else:
            speech_level = max(rms, speech_level * 0.995)
        # 收尾判据：低于噪声底 3 倍 或 低于说话电平的 22%，都算静音。
        # 取两者里更高的那个：宁可晚 200ms 收，也不要把句子中间的气口切断。
        end_need = max(min(noise_floor * VOICE_FACTOR, 0.05) if noise_floor is not None else 0.0, speech_level * SILENCE_RATIO, MIN_THRESHOLD * 0.8)
        if rms > end_need:
            speech_frames += 1
            silent_run = 0
        else:
            silent_run += 1
            if silent_run >= silence_frames and speech_frames >= min_speech_frames:
                # 尾巴上的静音不要（留 150ms 自然收尾）
                drop = max(0, silent_run - int(sr / CHUNK * 0.15))
                if drop:
                    collected = collected[: len(collected) - drop]
                    trimmed_ms = int(drop * CHUNK / sr * 1000)
                break
        if silent_run >= silence_frames and speech_frames < min_speech_frames:
            # 只是咳了一声/碰了麦：退回等待
            # 注意：rms_window 不清零——噪声底是环境属性，不该因为一句无效话就重估。
            started = False
            ring = []
            speech_frames = 0
            silent_run = 0
            collected = []
            speech_level = 0.0

    info = {
        "frames": len(collected),
        "noiseFloor": round(noise_floor or 0.0, 5),
        "threshold": round(threshold_now(), 5),
        "speechFrames": speech_frames,
        "trimmedMs": trimmed_ms,
        "hitMax": total >= max_frames,
    }
    return collected, info


def main():
    if len(sys.argv) > 1 and sys.argv[1] == "--list":
        pa = pyaudio.PyAudio()
        try:
            list_devices(pa)
        finally:
            pa.terminate()
        return

    out = sys.argv[1] if len(sys.argv) > 1 else "mic.wav"
    seconds = float(sys.argv[2]) if len(sys.argv) > 2 else 5.0
    forced = int(sys.argv[3]) if len(sys.argv) > 3 else None
    infinite = seconds == 0
    endpoint = seconds < 0
    abort_event = None
    ep_info = None

    pa = pyaudio.PyAudio()
    try:
        stream, dev = pick_and_open(pa, forced)
        name = dev.get("name", "?")
        sr = int(dev["defaultSampleRate"])
        ch = int(dev["maxInputChannels"])
        mode = "until-stop" if infinite else ("endpoint" if endpoint else str(seconds) + "s")
        print(f"device: [{dev['index']}] {name}  ch={ch}  sr={sr}  mode={mode}", flush=True)

        chunks = []
        if endpoint:
            # 自动断句：-1 等开口，-2 立刻开始（用于「接着说」判断）
            stop_event = threading.Event()
            abort_event = threading.Event()
            start_stdin_watcher(stop_event, abort_event)
            chunks, ep_info = record_endpointed(stream, sr, ch, wait_for_voice=(seconds != -2))
        elif infinite:
            # 一直录，后台线程监听 stdin
            stop_event = threading.Event()
            abort_event = threading.Event()
            start_stdin_watcher(stop_event, abort_event)
            while not stop_event.is_set():
                chunks.append(stream.read(CHUNK, exception_on_overflow=False))
        else:
            total = int(sr / CHUNK * seconds)
            for _ in range(total):
                chunks.append(stream.read(CHUNK, exception_on_overflow=False))

        stream.stop_stream()
        stream.close()

        raw = b"".join(chunks)
        data = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
        if ch > 1:
            data = data.reshape(-1, ch).mean(axis=1)

        if abort_event is not None and abort_event.is_set():
            print("aborted: 不写文件", flush=True)
            return
        if endpoint and not chunks:
            # 整段没人说话（或者只咳了一声被退回）：不写空文件，交给上层重试
            print(
                f"nospeech: noise={ep_info['noiseFloor']} th={ep_info['threshold']} waited>{MAX_WAIT_SEC}s",
                flush=True,
            )
            return
        pcm = write_wav(out, data, sr, ch)
        peak = float(np.max(np.abs(data))) if len(data) else 0.0
        rms = float(np.sqrt(np.mean(data ** 2))) if len(data) else 0.0
        sec = len(pcm) / 2 / TARGET_SR
        extra = ""
        if ep_info is not None:
            extra = (
                f" noise={ep_info['noiseFloor']} th={ep_info['threshold']}"
                f" trimmed={ep_info['trimmedMs']}ms hitMax={ep_info['hitMax']}"
            )
        print(f"ok: {out} ({len(pcm) // 2} samples @ {TARGET_SR}Hz = {sec:.2f}s) peak={peak:.4f} rms={rms:.4f}{extra}", flush=True)
    finally:
        pa.terminate()


if __name__ == "__main__":
    main()
