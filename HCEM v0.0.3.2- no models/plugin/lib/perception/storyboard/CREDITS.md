# 第三方来源（storyboard 模块）

本目录下的 `segments.js`、`density.js`、`candidates.js`、`scan.js`、`probe.js` 拆自：

- **项目**：dsh-video-storyboard（v0.3.0）
- **作者**：SAOS-3624
- **许可**：MIT
- **仓库**：https://github.com/SAOS-3624/dsh-video-storyboard

用途：HCEM 视觉系统的「镜头切分 / 密度分配 / 代表帧选择」能力。

- 纯函数模块（segments/density/candidates）：零依赖，直接复用；
- `scan.js` / `probe.js`：依赖 ffmpeg/ffprobe（视频文件分析时需要）。

原项目版权归原作者所有，HCEM 仅做集成与适配。
