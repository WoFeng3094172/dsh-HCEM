"""PANNs CNN14：音频 → AudioSet 527 类标签（JSON 输出）
用法：python panns.py <wav> [top_k=5]
输出：{"ok":true,"tags":[{"label":"Speech","score":0.9},...],"kind":"voice|music|scene"}
"""
import sys
import os
import json

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
PANNS_DIR = os.path.join(HERE, "..", "..", "..", "models", "panns")
TFLITE = os.path.join(PANNS_DIR, "cnn14_audioset_fp16.tflite")
MEL = os.path.join(PANNS_DIR, "mel_basis.bin")
LABELS = os.path.join(PANNS_DIR, "audioset_labels.txt")

SR, NFFT, HOP, NMEL = 32000, 1024, 320, 64
PAD = NFFT // 2

# 关键词 → 类别（AudioSet 标签里含这些词即归类）
VOICE_WORDS = ("speech", "male", "female", "narration", "conversation", "singing")
MUSIC_WORDS = (
    "music",
    "musical",
    "guitar",
    "piano",
    "drum",
    "singing",
    "violin",
    "bass",
    "instrument",
    "orchestra",
    "synthesizer",
    "electronic",
    "rock",
    "pop",
    "jazz",
    "classical",
)


def read_wav(path):
    import wave

    with wave.open(path, "rb") as w:
        n = w.getnframes()
        ch = w.getnchannels()
        sr = w.getframerate()
        data = w.readframes(n)
    x = np.frombuffer(data, dtype=np.int16).astype(np.float32) / 32768.0
    if ch > 1:
        x = x.reshape(-1, ch).mean(axis=1)
    if sr != SR:
        t_old = np.linspace(0, 1, len(x), endpoint=False)
        t_new = np.linspace(0, 1, int(len(x) * SR / sr), endpoint=False)
        x = np.interp(t_new, t_old, x)
    return x


def logmel(x):
    mel_basis = np.fromfile(MEL, dtype=np.float32).reshape(NMEL, NFFT // 2 + 1)
    xp = np.pad(x, (PAD, PAD), mode="reflect")
    win = np.hanning(NFFT + 1)[:-1].astype(np.float32)
    n_frames = 1 + (len(xp) - NFFT) // HOP
    spec = np.empty((n_frames, NFFT // 2 + 1), dtype=np.float32)
    for i in range(n_frames):
        seg = xp[i * HOP: i * HOP + NFFT] * win
        spec[i] = np.abs(np.fft.rfft(seg)) ** 2
    mel = spec @ mel_basis.T
    lm = 10.0 * np.log10(np.maximum(mel, 1e-10))
    if lm.shape[0] < 1001:
        lm = np.pad(lm, ((0, 1001 - lm.shape[0]), (0, 0)), mode="constant")
    else:
        lm = lm[:1001]
    return lm.astype(np.float32)[None, None, :, :]


def load_labels():
    out = []
    with open(LABELS, encoding="utf-8") as f:
        for line in f:
            parts = line.strip().split(",")
            if parts:
                out.append(parts[-1])
    return out


def classify(tags):
    text = " ".join(t["label"].lower() for t in tags)
    if any(w in text for w in MUSIC_WORDS):
        return "music"
    if any(w in text for w in VOICE_WORDS):
        return "voice"
    return "scene"


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"ok": False, "error": "usage: python panns.py <wav>"}))
        return
    wav = sys.argv[1]
    top_k = int(sys.argv[2]) if len(sys.argv) > 2 else 5
    try:
        x = read_wav(wav)
        if len(x) < SR:
            x = np.pad(x, (0, SR - len(x)))
        lm = logmel(x[: SR * 10])
        from ai_edge_litert.interpreter import Interpreter

        interp = Interpreter(model_path=TFLITE)
        interp.allocate_tensors()
        inp = interp.get_input_details()[0]
        out = interp.get_output_details()[0]
        interp.set_tensor(inp["index"], lm)
        interp.invoke()
        probs = interp.get_tensor(out["index"])[0]
        labels = load_labels()
        idx = np.argsort(probs)[::-1][:top_k]
        tags = [
            {"label": labels[i] if i < len(labels) else str(i), "score": float(probs[i])}
            for i in idx
        ]
        print(json.dumps({"ok": True, "tags": tags, "kind": classify(tags)}, ensure_ascii=False))
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": str(e)}))


if __name__ == "__main__":
    main()
