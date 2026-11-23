# HCEM Desktop（Tauri 独立 exe）

这是一个 **Tauri 桌面程序**，不依赖 DSH 的 Web 沙盒：编译后是独立 `app.exe`，自带 WebView2 窗口，悬浮球和主菜单都是原生窗口。

## 编译

```
call "D:\Microsoft Visual Studio\18\Community\VC\Auxiliary\Build\vcvars64.bat"
set TMP=<缓存目录>\tmp
set TEMP=<缓存目录>\tmp
set CARGO_HOME=<Rust 工具链>\cargo
set RUSTUP_HOME=<Rust 工具链>\rustup
set PATH=<Rust 工具链>\cargo\bin;%PATH%
cd /d "<安装目录>\ui"
cargo tauri build --no-bundle
```

产物：`src-tauri\target\release\app.exe`（约 8.7 MB，需要系统已安装 WebView2）。

增量编译约 30 秒；改了 `src/*.html` 也需要重新 build，因为前端资源是嵌进 exe 的。

## 窗口

| 窗口 | 文件 | 尺寸 | 说明 |
|---|---|---|---|
| `orb` | `src/index.html` | 160×160 | 透明、无边框、置顶、跳过任务栏，启动即在屏幕右下角 |
| `menu` | `src/menu.html` | 980×720 | 透明、无边框、置顶，默认隐藏，点悬浮球时显示 |

窗口在 `src-tauri/src/lib.rs` 里创建；WebView2 数据目录放在 `<安装目录>\.tauri-data\{orb,menu}`，避免 C 盘权限问题。

IPC 命令：`open_menu` / `close_menu` / `set_orb_visible`（前端用 `window.__TAURI__.core.invoke`，没有就退回 `window.hcem`）。

## 不编译也能看

直接用浏览器打开：

- `src/preview.html` —— 模拟桌面 + 悬浮球 + 右键菜单 + 主菜单，全部可点
- `src/menu.html?page=persona&nointro=1` —— 单看某一页

## UI 组件对照素材

| 组件 | 素材 | 实现 |
|---|---|---|
| 悬浮球 | `悬浮球.txt` | loader 动画（流动 mask + colorize），HSL 驱动颜色与速度 |
| 光圈 01 | `悬浮球光圈01.txt` | 悬停时绿蓝渐变环淡入 |
| 光圈 02 | `悬浮球光圈02.txt` | 长按/说话时旋转模糊环 |
| 存档按钮 | `角色卡-文本框.txt` | 5 个蓝点 + hover 扩散 scale(4) + 成功变绿 |
| 返回按钮 | `back.txt` | 同上 5 点扩散 + 右箭头 |
| 启动按钮 | `常驻启动按钮.txt` | 黄色星星 clip-path 旋转 + 蓝绿渐变 + 三层环（深/白/青） |
| 检测按钮 | `本地服务检测.txt` | SVG 芯片 + 8 条走线 + Loading 流动光效 |
| Consent | `警告consent.txt` | Consent/Thanks 翻转 |
| 警告卡 | `警告卡片.txt` | 卡片角展开覆盖，进入弹窗时默认展开 |
| 搭话度 | `搭话度.txt` | 竖向 glider，三色（橙/黄/蓝） |
| 性格滑块 | `性格滑块.txt` | -15~15，颜色随值在红↔绿间插值 |

## 还没接的

1. `state.H/S/L` 在 exe 里还是默认值，要从 DSH 插件桥接进来；
2. 角色卡/设置的保存只写 `localStorage`，没落 `data/`；
3. 多模态「启动」只是按钮状态，没拉起本地服务；
4. 右键菜单还没做成独立小窗口（现在右键 = 打开主菜单）。
