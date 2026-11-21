"""系统音频采集（WASAPI loopback）→ 16kHz 单声道 wav
用法：python record.py <输出 wav> [时长秒数=5]
依赖：pyaudiowpatch

注意：没有音频在播放时，WASAPI 回环可能不产生任何数据包，
stream.read() 会一直阻塞（实测卡死，直到外层 15 秒超时被杀）。
所以这里用看门狗线程：超时就把流停掉，拿到多少算多少，一条都拿不到就明确报错。
"""
import sys
import threading
import time
import wave

import numpy as np
import pyaudiowpatch as pyaudio

CHUNK = 1024
TARGET_SR = 16000


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else "audio.wav"
    seconds = float(sys.argv[2]) if len(sys.argv) > 2 else 5.0
    pa = pyaudio.PyAudio()
    try:
        wasapi = pa.get_host_api_info_by_type(pyaudio.paWASAPI)
        default_out = pa.get_device_info_by_index(wasapi["defaultOutputDevice"])
        if not default_out.get("isLoopbackDevice"):
            for loop in pa.get_loopback_device_info_generator():
                if default_out["name"] in loop["name"]:
                    default_out = loop
                    break
            else:
                raise RuntimeError("找不到 loopback 设备")
        sr = int(default_out["defaultSampleRate"])
        ch = int(default_out["maxInputChannels"])
        stream = pa.open(
            format=pyaudio.paInt16,
            channels=ch,
            rate=sr,
            input=True,
            input_device_index=default_out["index"],
            frames_per_buffer=CHUNK,
        )
        frames = []
        done = threading.Event()
        total = int(sr / CHUNK * seconds)

        def reader():
            try:
                for _ in range(total):
                    frames.append(stream.read(CHUNK, exception_on_overflow=False))
            except Exception:
                pass
            finally:
                done.set()

        reader_thr = threading.Thread(target=reader, daemon=True)
        reader_thr.start()
        # 多给 2 秒余量；超时说明音频端点没在送数据（多半是当前没声音在播）
        if not done.wait(seconds + 2.0):
            try:
                stream.stop_stream()
            except Exception:
                pass
            done.wait(1.0)
        try:
            stream.stop_stream()
        except Exception:
            pass
        try:
            stream.close()
        except Exception:
            pass

        if not frames:
            raise RuntimeError("loopback 没有数据（当前没有音频在播放？）")
        # 不足要求时长就用实际拿到的，不补静音——补了反而会被当成"听到了安静"
        raw = b"".join(frames)
        data = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
        if ch > 1:
            data = data.reshape(-1, ch).mean(axis=1)
        # 重采样到 16k（线性插值）
        if sr != TARGET_SR:
            t_old = np.linspace(0, 1, len(data), endpoint=False)
            t_new = np.linspace(0, 1, int(len(data) * TARGET_SR / sr), endpoint=False)
            data = np.interp(t_new, t_old, data)
        # 不足 0.3 秒基本等于"没听到东西"：与其把 0.02 秒噪声送去分类，
        # 不如明确告诉调用方这一轮没有音频（上层据此跳过，不产生记忆）。
        if len(data) < int(TARGET_SR * 0.3):
            raise RuntimeError(f"loopback 数据太少（{len(data)} 样本，当前没有音频在播放？）")
        pcm = (data * 32767).astype(np.int16).tobytes()
        with wave.open(out, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(TARGET_SR)
            w.writeframes(pcm)
        print(f"ok: {out} ({len(pcm) // 2} samples @ {TARGET_SR}Hz)")
    finally:
        pa.terminate()


if __name__ == "__main__":
    main()
