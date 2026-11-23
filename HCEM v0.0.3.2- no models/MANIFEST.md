# HCEM v0.0.3.2 · 源码发布包

- 版本：`0.0.3.2`
- 整理：2026-11-24
- 内容：DSH 插件、桌面中控源码、预构建 `HCEM.exe`、设计/验证文档、启动脚本
- **不含**：模型权重、`python-venv/`、`data/`、`logs/`、ffmpeg 二进制

## 目录

| 路径 | 内容 |
|---|---|
| `plugin/` | DSH 插件（`index.mjs`、`lib/`、`client.js`、`tools/`、`locale/`、测试） |
| `ui/` | 桌面中控源码（`src/`、`src-tauri/`） |
| `HCEM.exe` | 预构建桌面中控（Windows x64，未签名） |
| `docs/` | 记忆检索与 Commis 计划、端到端验证清单、训练计划 |
| `models/models.md` | 模型清单、端口、Python 依赖、放置说明 |
| `安装必看.md` | 安装前必读：GitHub 包外依赖、模型/环境/解码器/构建步骤 |
| `tools/` | 启动/开发辅助脚本（ffmpeg 需自行下载） |
| `start-services.mjs` | 本地服务启动入口 |

## 最小运行条件

1. Windows 10/11 x64
2. DSH 当前版本
3. 按 `models/models.md` 放置模型
4. 按 `models/models.md` 第七节准备 Python 运行时（torch/funasr/onnxruntime 等）
5. `node start-services.mjs`

## 说明

- 这是“陪伴”项目，不是医疗设备，不能替代心理治疗或危机干预。
- 设计上会遗忘、会模糊、情绪极化时可能轻度幻觉。
- 画面与声音只在本机处理；代码不含任何云端密钥。
- 模型许可证以各自发布页为准；本项目代码以 MIT 发布。
