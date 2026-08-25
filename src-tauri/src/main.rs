//! abcde 桌面应用入口。
//!
//! 仅负责启动 Tauri 库（[`abcde_lib::run`]）；在 release 模式下隐藏
//! Windows 控制台窗口。

// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    abcde_lib::run()
}
