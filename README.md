<div align="center">
<img src="src/assets/app-icon.svg" width="48" height="48">
<h1>Hark</h1>

一个开源、轻量、纯离线的 Ark 字节码（.abc / .hap / .har）反编译工作台。

简体中文
</div>

<div align="center">
<a href="https://github.com/1595901624/hark/releases"><img src="https://img.shields.io/github/v/release/1595901624/hark?display_name=tag&label=version&color=blue" alt="Version"></a>
<img src="https://img.shields.io/badge/Windows-Supported-blue" alt="Windows">
<img src="https://img.shields.io/badge/macOS-Supported-blue" alt="macOS">
<img src="https://img.shields.io/badge/Linux-Supported-blue" alt="Linux">
</div>

## 为什么需要 Hark

鸿蒙（HarmonyOS / OpenHarmony）应用以 Ark 字节码（`.abc`）形式分发，分析其行为往往依赖命令行工具 `ark_disasm`，缺少可视化的浏览与检索体验。Hark 把「打开应用包 → 浏览字节码 → 反汇编 / 还原 ArkTS → 全局检索 → 导出」串联成一个流畅的桌面工作台，目标是：

- **纯离线**：所有解析与检索均在本地完成，不上传任何数据
- **可视化浏览**：jadx-gui 风格布局，左侧项目树 / 全局搜索双视图 + 右侧多标签代码区
- **双视图**：每个单元同时提供 `.abc` 反汇编与 `.ets`（ArkTS 还原）视图，按需加载并缓存
- **可追溯**：工作区快照可保存为 `.hark` 文件，完整恢复标签、视图与项目树展开现场
- **跨平台**：Windows 10/11、macOS 10.13+（Intel & Apple Silicon）、Linux 桌面（需 WebKit2GTK ≥4.1）

Hark 基于 [Tauri v2](https://v2.tauri.app/) + [React](https://react.dev/) 构建，内置 `ark_disasm` 并提供路径配置，专注于纯离线的反编译工作流。

## ✨ 特性亮点

- **多标签编辑器**：最多 12 个标签，懒加载节点内容，超出时自动淘汰最早标签
- **双视图切换**：每个内容区提供 `.abc`（反汇编）/ `.ets`（ArkTS 还原）双视图，按需加载并缓存两份内容
- **全局搜索（Ctrl+Shift+F）**：多类别检索，结果点击后打开对应类并定位到行
- **编辑器内查找（Ctrl+F）**：高亮全部匹配，支持上一个 / 下一个导航
- **工作区快照**：保存 / 另存为 `.hark` 二进制文件，打开时校验完整性并恢复标签、视图与项目树展开现场
- **批量导出**：文件 → 导出，把项目内全部原始 `.abc` 字节码与全部单元反汇编（`.pa`）批量导出到所选目录
- **单文件导出**：反汇编可导出为 `.pa`，ArkTS 还原结果可导出为 `.ets`
- **多种打开方式**：原生对话框 / `Ctrl+O` / 拖拽打开 `.abc` / `.hap` / `.har` / `.app` / `.hark`
- **可折叠侧栏**：标题栏按钮切换，宽度与视图选择持久化
- **主题**：深色 / 浅色模式，支持跟随系统
- **状态持久化**：侧栏宽度、侧栏视图、反编译器路径等通过 Tauri Store 自动保存

## 🧰 功能详解

### 📂 项目浏览

- 支持 `.abc` / `.hap` / `.har` / `.app` / `.hark` 文件
- 左侧项目树按包 / 类层级展示，可展开收起，状态随工作区保存
- 全局搜索与项目树双视图切换
- 通过原生对话框、`Ctrl+O` 或拖拽打开文件

### 🔍 检索

- **全局搜索（Ctrl+Shift+F）**：多类别检索（类名、方法、字符串等），结果点击后打开对应类并定位行
- **编辑器内查找（Ctrl+F）**：高亮全部匹配，支持上一个 / 下一个导航

### 📝 代码视图

- **反汇编视图（`.abc`）**：展示 Ark 字节码反汇编结果，可导出为 `.pa`
- **ArkTS 还原视图（`.ets`）**：展示还原后的 ArkTS 源码，可导出为 `.ets`
- 双视图按需加载并缓存，切换无需重复请求
- 支持语法高亮

### 💾 工作区快照

- 保存 / 另存为 `.hark` 二进制工作区文件
- 打开 `.hark` 时校验完整性并恢复标签、视图与项目树展开现场
- 支持关闭项目

### ⚙️ 反编译器配置

- 内置 `ark_disasm`，随应用打包，运行时按平台自动探测
- 运行时探测优先级（见 `src-tauri/src/runner.rs::locate`）：
  1. 设置页手动配置的路径（用户覆盖，优先级最高）
  2. `HARK_ARK_DISASM` 环境变量
  3. 应用内置副本
  4. 应用可执行文件同目录
  5. 系统 `PATH`
- 未放入二进制时应用仍可运行，但打开 `.abc` / `.hap` / `.har` 会提示找不到 `ark_disasm`

## 🚀 技术栈

- **核心**：[Rust](https://www.rust-lang.org/) & [Tauri v2](https://tauri.app/)
- **前端**：[React 19](https://react.dev/) & [TypeScript](https://www.typescriptlang.org/)
- **构建工具**：[Vite](https://vitejs.dev/)
- **UI**：[Base UI](https://base-ui.com/) & [Tailwind CSS](https://tailwindcss.com/) & [lucide-react](https://lucide.dev/)
- **Tauri 插件**：dialog、opener、store

## 🛠️ 快速开始

### 前置要求

- Node.js 18+
- pnpm
- Rust（stable）
- Tauri v2 系统依赖（因平台而异，首次构建失败请参考 Tauri 文档）。Linux 需安装 WebKit2GTK 4.1 或更高版本（Ubuntu 24.04+ 软件包兼容）。

### 安装

```bash
git clone https://github.com/1595901624/hark.git
cd hark
pnpm install
```

### 内置 ark_disasm（可选）

如需内置 `ark_disasm`，从 [OpenHarmony ArkCompiler 工具链](https://repo.huaweicloud.com/openharmony/os/) 的 `toolchains` 包中获取对应平台二进制，按下方结构放入：

```
src-tauri/resources/bin/
├── windows/ark_disasm.exe
├── macos/ark_disasm        (aarch64 / x86_64)
└── linux/ark_disasm        (x86_64)
```

macOS / Linux 下记得赋予执行权限：`chmod +x ark_disasm`。

> 未放入二进制时应用仍可运行，也可在设置页手动指定 `ark_disasm` 路径。

### 开发

```bash
pnpm tauri dev
```

### 构建

```bash
pnpm tauri build
```

## 🔒 隐私

- Hark 定位为**纯离线**反编译工作台，所有解析与检索均在本地完成。
- 用户输入与打开的文件均在本地处理，不会发送到外部服务器。

## 📂 项目结构

```
Hark/
├── src-tauri/              # Rust 后端与 Tauri 配置
│   ├── src/
│   │   ├── decompiler/     # 反编译核心（指令解析、表达式、签名、反汇编输出）
│   │   ├── project.rs      # 项目打开 / 解析 / 字节码提取
│   │   ├── search.rs       # 全局检索
│   │   ├── runner.rs       # ark_disasm 探测与调用
│   │   └── lib.rs          # Tauri 命令注册
│   ├── resources/bin/      # 内置 ark_disasm（按平台分目录）
│   └── tauri.conf.json     # Tauri 配置
├── src/                    # React 前端源码
│   ├── components/
│   │   ├── workspace/      # 反编译工作台（项目树、编辑器标签、代码视图、搜索面板）
│   │   ├── settings/       # 设置页
│   │   ├── ui/             # 基础 UI 组件
│   │   └── TitleBar.tsx    # 自定义标题栏
│   ├── hooks/              # 自定义 Hooks（持久化状态等）
│   ├── lib/                # 工具库（API、存储、平台检测）
│   ├── assets/             # 静态资源
│   └── styles/             # 全局样式
└── public/                 # 静态资源
```

## 🤝 参与贡献

欢迎提交 Issue 与 PR：

- Bug 修复与 UI / UX 改进
- 反编译还原质量提升
- 新平台二进制适配
- 文档与说明改进

## 📄 许可证

[MIT](LICENSE)
