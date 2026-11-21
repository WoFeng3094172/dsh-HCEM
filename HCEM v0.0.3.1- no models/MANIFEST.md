# HCEM 备份清单

- 变体：HCEM v0.0.3.1- no models（无模型）
- 源项目：HCEM v0.0.3.1
- 备份时间：2026/11/22 02:53:23
- 包含模型：**否**（`models/` 只有 `models.md`，按它自行下载）
- 文件数：216
- 总大小：12.5 MB

## 包含

- `plugin/` — DSH 侧插件（Cordis 插件、TTS、工具目录、Commis 等全部源码）
- `ui/src/` — 三个界面源码（悬浮球 / 菜单 / 快捷菜单）
- `ui/src-tauri/` — Rust 侧源码（窗口、桥、点击、清理）
- `tools/` — ffmpeg 与启动脚本
- `docs/` — 算法、工作日志、Commis 训练计划
- `HCEM.exe` — 已编译好的中控程序
- `models/models.md` — 模型清单与下载说明

## 已排除

- `logs/`、`python-venv/`、`.tmp/`、`node_modules/`、`ui/src-tauri/target/`、`.git`

## 恢复成可运行

1. Node.js 20+（插件跑在 DSH 里）
2. `HCEM v0.0.3.1- no models` 需要先按 `models/models.md` 下载模型
3. 双击 `HCEM.exe`；插件目录配到 DSH 的 profile 里
4. 想带回自己的记忆：把旧机器的 `data/` 覆盖过来

## data/

只有空目录骨架，每个目录的用途见 `data/数据目录说明.md`。

## 注意

- 为了让压缩包能上传，**没有带 ffmpeg**（原 314 MB）。
  需要声音/视频处理时自己装一份，放到 `tools/ffmpeg-9.0.2-essentials_build/` 或加入 PATH。

## 路径与安装位置（已可迁移）

代码里不再有作者盘符。启动时按「exe 所在目录」推导一切：

| 内容 | 位置 |
|---|---|
| 程序与插件 | `<安装目录>/HCEM.exe`、`<安装目录>/plugin/` |
| 数据 | `<安装目录>/data/` |
| 模型 | `<安装目录>/models/` |
| 日志 | `<安装目录>/logs/` |
| WebView2 用户数据 | `<安装目录>/.tauri-data/` |
| 临时文件 | `<安装目录>/.tmp/` |

插件侧（Node）优先读环境变量，其次按插件自己所在位置推：

- `HCEM_HOME` —— 安装根目录（可选）
- `HCEM_DATA_DIR` / `HCEM_MODELS_DIR` —— 单独挪数据/模型时用（可选）

> 已验证：整个文件夹复制到其他盘（如 `D:\hcem-final-test`）直接双击 `HCEM.exe` 即可运行，
> 数据、日志、WebView2 缓存都生成在新位置，不会去写任何写死的旧路径。

### 两个可选外部依赖

| 依赖 | 为什么没带 | 怎么补 |
|---|---|---|
| ffmpeg | 314 MB，占压缩包九成 | 放进 `tools/ffmpeg-9.0.2-essentials_build/`，或把 ffmpeg 加到 PATH |
| python-venv | 63 MB，可重建 | 只在听觉/人脸相关功能用到；按 `models/models.md` 的说明重建 |

没有它们时，核心对话、记忆、日记、Commis 都正常，只是对应功能会报「不可用」。

