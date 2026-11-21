"""声纹识别（3D-Speaker ECAPA-TDNN）→ 说话人 embedding / 相似度

用法：
  python voiceprint.py embed <wav> [out.npy]       提取声纹向量（192 维）
  python voiceprint.py compare <wav1> <wav2>       比对两段音频是否同一人
  python voiceprint.py identify <wav> <库目录>      拿 wav 和库里所有 .npy 比对

为什么不用官方 infer_sv.py：
  它依赖 modelscope.pipelines → 又要 datasets 等一堆重依赖。
  我们只需要「本地模型 + FBank + 余弦相似度」，直接调 speakerlab 的模型类就行。

模型（ECAPA_CNCeleb 配置，对应 pretrained/ecapa_cn_16k）：
  input_size=80, lin_neurons=192, channels=[1024,1024,1024,1024,3072]
  权重 ecapa_tdnn.bin 83MB，CPU 也能跑（一次约 0.3~1 秒）
"""

import os
import sys

import numpy as np
import torch

SPEAKERLAB = os.path.join('E:', os.sep, 'HCEM', 'HCEM v0.0.3.1', 'models', '3d-speaker')
sys.path.insert(0, SPEAKERLAB)

from speakerlab.process.processor import FBank  # noqa: E402
from speakerlab.utils.builder import dynamic_import  # noqa: E402

MODEL_DIR = os.path.join(SPEAKERLAB, 'pretrained', 'ecapa_cn_16k')
MODEL_PT = os.path.join(MODEL_DIR, 'ecapa_tdnn.bin')

ECAPA_CN = {
    'obj': 'speakerlab.models.ecapa_tdnn.ECAPA_TDNN.ECAPA_TDNN',
    'args': {
        'input_size': 80,
        'lin_neurons': 192,
        'channels': [1024, 1024, 1024, 1024, 3072],
    },
}

_cache = {}


def get_model():
    """懒加载模型（进程内复用，第二次调用约 0ms）"""
    if 'model' in _cache:
        return _cache['model'], _cache['fbank'], _cache['device']

    if not os.path.exists(MODEL_PT):
        raise RuntimeError(f'模型缺失: {MODEL_PT}')

    device = torch.device('cuda' if torch.cuda.is_available() else 'cpu')
    state = torch.load(MODEL_PT, map_location='cpu', weights_only=False)
    model = dynamic_import(ECAPA_CN['obj'])(**ECAPA_CN['args'])
    model.load_state_dict(state)
    model.to(device)
    model.eval()

    fbank = FBank(80, sample_rate=16000, mean_nor=True)
    _cache['model'] = model
    _cache['fbank'] = fbank
    _cache['device'] = device
    return model, fbank, device


def load_wav(path, target_fs=16000):
    """读 wav → (1, N) float32 tensor

    不用 torchaudio.load：torchaudio 2.11 起改用 torchcodec 后端，
    而 torchcodec 没装会直接 ImportError。我们的 wav 是标准 PCM 16bit，
    用内置 wave 模块读更快也更省事。
    """
    import wave

    with wave.open(path, 'rb') as w:
        fs = w.getframerate()
        ch = w.getnchannels()
        width = w.getsampwidth()
        raw = w.readframes(w.getnframes())

    if width != 2:
        raise RuntimeError(f'只支持 16bit wav，当前 {width * 8}bit')

    data = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    if ch > 1:
        data = data.reshape(-1, ch).mean(axis=1)

    # 重采样到 16k（线性插值）
    if fs != target_fs and len(data) > 0:
        t_old = np.linspace(0, 1, len(data), endpoint=False)
        t_new = np.linspace(0, 1, int(len(data) * target_fs / fs), endpoint=False)
        data = np.interp(t_new, t_old, data)

    return torch.from_numpy(data).unsqueeze(0)


def embed(wav_path):
    """返回 192 维 numpy 向量"""
    model, fbank, device = get_model()
    wav = load_wav(wav_path)
    feat = fbank(wav).unsqueeze(0).to(device)
    with torch.no_grad():
        emb = model(feat).detach().squeeze(0).cpu().numpy()
    return emb


def cosine(a, b):
    na = np.linalg.norm(a)
    nb = np.linalg.norm(b)
    if na == 0 or nb == 0:
        return 0.0
    return float(np.dot(a, b) / (na * nb))


def main():
    if len(sys.argv) < 3:
        print('用法: python voiceprint.py embed|compare|identify ...')
        sys.exit(2)

    cmd = sys.argv[1]

    if cmd == 'embed':
        wav = sys.argv[2]
        emb = embed(wav)
        out = sys.argv[3] if len(sys.argv) > 3 else None
        if out:
            os.makedirs(os.path.dirname(out) or '.', exist_ok=True)
            np.save(out, emb)
            print(f'ok: {out} dim={len(emb)}')
        else:
            print('emb:', ','.join(f'{v:.5f}' for v in emb[:8]), '...')

    elif cmd == 'compare':
        w1, w2 = sys.argv[2], sys.argv[3]
        e1 = embed(w1)
        e2 = embed(w2)
        score = cosine(e1, e2)
        # 经验阈值：0.5 以上大概率同一人（官方 yesOrno_thr 也是 0.5）
        print(f'similarity={score:.4f}')
        print('same' if score >= 0.5 else 'different')

    elif cmd == 'identify':
        wav = sys.argv[2]
        lib_dir = sys.argv[3]
        emb = embed(wav)
        best = None
        for name in sorted(os.listdir(lib_dir)):
            if not name.endswith('.npy'):
                continue
            try:
                ref = np.load(os.path.join(lib_dir, name))
            except Exception:
                continue
            s = cosine(emb, ref)
            tag = name[:-4]
            print(f'  {tag}: {s:.4f}')
            if best is None or s > best[1]:
                best = (tag, s)
        if best:
            print(f'best={best[0]} score={best[1]:.4f}')
        else:
            print('库是空的')

    else:
        print('未知命令:', cmd)
        sys.exit(2)


if __name__ == '__main__':
    main()
