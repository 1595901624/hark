# 内置 ark_disasm 二进制

本目录随应用打包（`tauri.conf.json` → `bundle.resources`），运行时按当前平台
自动探测对应的子目录，作为 `ark_disasm` 的默认来源。目录结构固定为：

```
resources/bin/
├── windows/ark_disasm.exe
├── macos/ark_disasm        (aarch64 / x86_64，按发布目标放置)
└── linux/ark_disasm        (x86_64)
```

## 放置步骤

1. 从 OpenHarmony 官方工具链发布物中获取对应平台的 `ark_disasm`
   （如 [OpenHarmony ArkCompiler 工具链](https://repo.huaweicloud.com/openharmony/os/) 中的 `toolchains` 包）；
2. 按上表放入对应平台子目录，文件名保持不变；
3. macOS / Linux 下记得赋予执行权限：`chmod +x ark_disasm`；
4. 重新执行 `pnpm tauri build` 即可内置。

## 运行时探测优先级

见 `src-tauri/src/runner.rs::locate`：

1. 设置页手动配置的路径（用户覆盖，优先级最高）；
2. `HARK_ARK_DISASM` 环境变量；
3. **本目录的内置副本**；
4. 应用可执行文件同目录；
5. 系统 `PATH`。

> 未放入二进制时应用仍可运行，但打开 `.abc` / `.hap` / `.har` 会提示找不到 ark_disasm。
