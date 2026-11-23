# HCEM 模型库

> 全部本地运行，不联网。除 DSH 对话本身外，任何画面、声音都不出本机。
> 路径：`E:\HCEM\HCEM v0.0.3.2\models\`
> 模型总占用约 **13 GB**（另有 `python-venv/`，含 torch/funasr 等，约 3 GB）
>
> **GitHub 仓库不含模型权重。** 本文件只说明目录结构、端口和依赖；权重需自行下载/放置。

---

## 一、模型清单

### 1.1 语言与向量

| 目录 | 模型 | 大小 | 端口 | 干什么 |
|---|---|---|---|---|
| `OmniDimen-4B-Emotion-GGUF-q4_K_M` | OmniDimen-4B（情绪微调） | 2382 MB | **8098** | 情绪判定、语义分析、综合输出（主对话模型） |
| `Qwen3-1.7B-Q4_K_M` | Qwen3-1.7B | 1058 MB | **8093** | 分流分类、梦的抽卡、摘要第一步（**CPU 常驻，0 显存**） |
| `Qwen3-Embedding-0.6B-Q8_0` | Qwen3-Embedding | 610 MB | **8094** | 文本向量化（1024 维），语义检索与缓存（**常驻**） |
| `llama.cpp-cuda` | llama-server（GPU 运行时） | 1381 MB | — | 所有 GGUF 的 GPU 推理 |
| `llama.cpp-cpu` | llama-server（CPU 运行时） | 60 MB | — | Qwen3-1.7B 的 CPU 推理 |

### 1.2 视觉

| 目录 | 模型 | 大小 | 端口 | 干什么 |
|---|---|---|---|---|
| `Qwen2.5-VL-3B-Instruct-GGUF` | Qwen2.5-VL-3B + mmproj | 2646 MB | **8091** | 看屏幕 / 看视频 / 读画面文字（OCR 顺带做） |
| `hsemotion` | HSEmotion B0（TFLite fp16） | 9 MB | — | 人脸情绪（8 类 AffectNet） |
| `vibenet-main` | VibeNet（EfficientNet ONNX） | 47 MB | — | 画面整体氛围 / 情绪色调 |

> **SmolVLM2-500M 已退役**（8092）。它的描述质量不够、又要单独占显存，现在所有视觉判断统一交给 Qwen2.5-VL。

### 1.3 听觉

| 目录 | 模型 | 大小 | 干什么 |
|---|---|---|---|
| `CrispASR-v0.8.53-win-x64-cuda` | `crispasr.exe`（多后端运行时） | 1011 MB | 语音识别运行时（qwen3 / whisper / paraformer 都能跑） |
| `qwen3-asr-crisp` | `qwen3-asr-0.6b-q8_0.gguf`（**融合版**） | 960 MB | 语音识别模型 |
| `emotion2vec+base` | emotion2vec+ | 1069 MB | 语音情绪（高兴 / 悲伤 / 愤怒…） |
| `panns` | PANNs CNN14（fp16） | 154 MB | 环境声 / 音乐分类（这是什么声音） |
| `3d-speaker` | ECAPA-TDNN | 162 MB | 声纹识别（这是谁在说话） |
| `chromaprint` | `fpcalc.exe` | 4 MB | 音乐指纹（同一首再听到能认出来） |
| `Fun-CosyVoice3-0.5B-2512` | CosyVoice3（3 个 GGUF） | 1647 MB | 语音合成（AI 说话） |

> **SenseVoice 与 FSMN-VAD 已退役。** 识别改用 CrispASR + Qwen3-ASR，VAD 由 CrispASR 内部处理。
> 旧模型目录已移到 `E:\HCEM\.tmp\retired-sensevoice-20261120\`（约 770 MB，确认无用后可删）。

---

## 二、模型分工

### 2.1 按「干什么」分

| 任务 | 用哪个模型 | 为什么是它 |
|---|---|---|
| **AI 的"思考"与说话** | OmniDimen-4B | 情绪微调过，输出带情绪倾向 |
| **理解用户说的话** | OmniDimen-4B | 语义分析一体 |
| **分流（这条要不要走本地）** | Qwen3-1.7B | 路由分类实测 12/15（0.6B 只有 7/15，且系统性把 cloud 判成 local） |
| **感知摘要第一步（客观摘要）** | Qwen3-1.7B | CPU 跑，不抢显存 |
| **感知摘要第二步（讲成人话）** | OmniDimen-4B | 带 me + HSL + 记忆，输出才有"我"的口吻 |
| **看屏幕 / 看视频** | Qwen2.5-VL-3B | 一个模型同时干精看和 OCR |
| **听懂说什么** | Qwen3-ASR-0.6B（CrispASR） | 15.3x 实时，标点齐全（SenseVoice 只有 3x 且丢标点） |
| **听出情绪** | emotion2vec+ | 语音情绪专用 |
| **听出是什么声音** | PANNs CNN14 | 环境声 / 音乐分类 |
| **听出是谁** | ECAPA-TDNN | 声纹 192 维 |
| **同一首歌认出来** | Chromaprint | 指纹约 1 KB |
| **音乐结构分析** | 纯 DSP（`lib/audio/dsp/`） | BPM / 调性 / 和弦 / 段落不花一次推理 |
| **看人脸情绪** | HSEmotion | 8 类，轻量 |
| **看画面氛围** | VibeNet | 整体色调 / 氛围 |
| **说给用户听** | CosyVoice3 | 0.5B，自然度够 |
| **记住东西（检索）** | Qwen3-Embedding | 1024 维，区分度好 |

### 2.2 显存与错峰（实测）

| 模型 | 显存 | 什么时候在 |
|---|---|---|
| Qwen3-1.7B | **0**（CPU，1687 MB 内存） | 常驻（随 exe） |
| Qwen3-Embedding | 约 1.1 GB | **常驻**（不跟任何开关绑定） |
| OmniDimen-4B | **约 2.5 GB**（`-c 8192` + KV q8_0） | 对话时 / 听声音 / 感知摘要 |
| Qwen2.5-VL-3B | 约 3.2 GB（`-c 4096` + KV q8_0） | 只在看屏幕 / 看视频时拉起 |
| Qwen3-ASR | 约 0.9 GB（进程退出即释放） | 识别时临时起进程 |

**错峰的规矩**（`lib/perception/gpu-queue.mjs`）：

```
优先级 embedding(100) > qwen3(90) > omni(70) > qwen25vl(50)
显存不够时排队的任务等前一个测完再上，不会两个 3B 一起挤爆
```

### 2.3 KV 量化

8098 和 8091 都用 `--flash-attn on --cache-type-k q8_0 --cache-type-v q8_0`：

- Omni 上下文 4096 → 8192，显存只从约 2.3 GB 涨到 2.5 GB（f16 时是 3.0 GB）
- 代价是极轻微的质量损失，实测对话和情绪判定都看不出来

---

## 三、模型生命周期（重要）

**模型的生死归 HCEM.exe 管，不归任何开关管。**

| 时机 | 发生什么 |
|---|---|
| HCEM.exe 启动 | pipe 连上 → 插件按开关把该起的模型拉起来（常驻 embedding 一定起） |
| 空闲 9 分钟 | 开始做梦（用 Qwen3-1.7B 抽卡 + Omni 写梦） |
| 空闲 30 分钟 | 休眠 → **全部模型关掉** |
| 用户有输入 | 从休眠醒来 → 按开关重新拉起 |
| HCEM.exe 关闭 | **全部模型关掉**（pipe 断开 + 插件 30 秒看门狗双保险） |

开关只决定"**哪些**模型"，不决定"**模型该不该活着**"。

### 开关 → 模型对照（`lib/services.mjs`）

| 开关 | 拉起哪些 |
|---|---|
| 视觉常驻（桌面 / 视频） | qwen25vl (8091) |
| 听觉常驻 | omni (8098) |
| 本地分流 | qwen3 (8093) + omni (8098) |
| 语音输出 / 语音输入 | 不占 llama 端口（走 Python） |
| **（无开关）** | **embedding (8094)：常驻，永远在** |

---

## 四、端口总表

```
8091  Qwen2.5-VL-3B     看屏幕 / 视频      -c 4096  flash-attn  KV q8_0
8093  Qwen3-1.7B        分流 / 摘要第一步   -c 4096  CPU(-ngl 0) KV q8_0
8094  Qwen3-Embedding   向量               -c 2048  --embedding --pooling mean
8098  OmniDimen-4B      情绪 / 摘要 / 对话  -c 8192  flash-attn  KV q8_0
8097  HCEM 语音通道      插件 HTTP（不是模型，但排查时经常要看）
```

8092（SmolVLM）已停用。

---

## 五、踩过的坑

**① Qwen3-ASR 必须用融合版**

`cstr/qwen3-asr-0.6b-GGUF` 那种把 mel 滤波器烤进主模型的版本才行。
主模型 + `mmproj` 分离的那种（HuggingFace 上的 `Qwen3-ASR-0.6B-GGUF`）CrispASR 读不了，会报：

```
qwen3_asr: model GGUF missing audio.mel_filters / audio.mel_window
```

CLI 只接受 libmtmd 字符串，不认 `--mmproj`。

**② 热词会"念提示词"**

极轻录音（峰值 < 0.01）时，Qwen3-ASR 会把 `--context` 里的热词表原样吐出来当识别结果。
`lib/audio/asr.mjs` 有两道闸：峰值门（`SILENT_PEAK`）+ 输出比对（过半命中热词表就判空）。

**③ 没有音频在播时 WASAPI 回环会阻塞**

`record.py` 的 `stream.read()` 在音频端点不送数据时会一直卡住（原来靠外层 15 秒超时）。
现在用看门狗线程，`seconds + 2` 秒没读完就停流，不足 0.3 秒直接判"没听到"。

**④ 模型文件缺失的静默失败**

`startService` 找不到模型文件只打一行 warn 就跳过，端口一直空着。
排查时先确认 `models\<目录>\<文件>.gguf` 真的在。

---

## 五点五、非模型的「模型」：热菜助理 Commis

Commis 不是 GGUF，也不占显存——它是工具排序用的小线性头（约 120 KB，CPU <1 ms）。

| 项 | 值 |
|---|---|
| 作用 | 在向量检索结果上再排一次序，决定"先给我哪个工具" |
| 位置 | `data/classifier/head.json`（模型）/ `data/classifier/labels.jsonl`（训练数据） |
| 开关 | `data/ui-state/classifier.json`（默认 `false`，菜单 → 设置） |
| 训练 | `hcem_commis(action=train)` 或 `node plugin/tools/train-classifier.mjs` |
| 依赖 | 8094（Qwen3-Embedding，CPU）算查询向量 |
| 计划 | `docs/Commis_训练计划_用户版.md` / `docs/Commis_训练计划_AI.md` |

它**不改检索基线**：混合公式 0.7×向量 + 0.3×Commis，权重上限 0.6；删掉 head.json 即完全回退。

---

## 六、换模型 / 加模型

1. 把 GGUF 放到 `models\<名字>\`，注意 `join(MODELS, ...)` 的路径要和 `lib/services.mjs` 里一致
2. 在 `SERVICES` 里加一条：`name / port / model / args`
3. 想让它跟某个开关走，加到 `MOD_SERVICES` 对应开关的数组里
4. 想让它常驻，加到 `ALWAYS_ON`
5. 改完重启 DSH（模型管理在插件里，不用重编 exe）

> **mmproj 类模型**（Qwen2.5-VL）要同时给 `model` 和 `mmproj` 两个字段。

---

## 七、Python 运行时依赖（python-venv）

音频情感/人脸情绪/音乐情感不是 GGUF，而是 Python 进程：

| 依赖 | 用途 | 备注 |
|---|---|---|
| `torch` / `torchaudio`（CPU 版） | emotion2vec 推理 | 约 200 MB 安装包；不要装 CUDA 版，CPU 够用 |
| `funasr` | emotion2vec+base 加载 | 模型文件 `emotion2vec+base/model.pt`（约 1 GB） |
| `onnxruntime` | VibeNet（音乐情感） | CPU |
| `librosa` / `audioread` / `pydub` | VibeNet 读音频 | |
| `opencv-python-headless` / `ai-edge-litert` | 人脸情绪（HSEmotion TFLite） | |

安装示例（国内可用清华镜像）：

```powershell
python -m pip install torch torchaudio --index-url https://download.pytorch.org/whl/cpu
python -m pip install -i https://pypi.tuna.tsinghua.edu.cn/simple funasr onnxruntime librosa audioread pydub
```

`emotion2vec+base/e2v_test.py` 用脚本所在目录定位模型，不再写死安装路径。

---

## 八、GitHub 分发说明

- 仓库不包含 `models/` 权重、`python-venv/`、`data/`、`logs/`、`HCEM.exe`。
- 第一次运行前按本文件把模型放到 `models/`，并用上面的命令准备 `python-venv/`。
- 端口、启动参数和开关映射见 `plugin/lib/services.mjs`；修改模型路径时同步改那里。
- 模型各自的许可证以其原始发布页为准；本项目代码以 MIT 发布。
