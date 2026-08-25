//! abcde 库入口：注册 Tauri 插件、共享状态与前端可调用的命令。
//!
//! 命令一览：
//! - [`open_project`]：打开 `.abc` / `.hap` / `.har` 并返回项目树；
//! - [`get_content`]：按节点 ID 获取内容切片；
//! - [`close_project`]：关闭当前项目；
//! - [`set_disassembler_path`]：配置官方 `ark_disasm` 路径。

mod pa;
mod project;
mod runner;

use std::sync::Mutex;

use project::{NodeContent, Project, TreeNode};
use tauri::State;

/// 应用共享状态：当前项目 + 反编译工具路径配置。
struct AppState {
    /// 当前打开的项目；`None` 表示未打开。
    project: Mutex<Option<Project>>,
    /// 用户配置的 `ark_disasm` 路径；`None` 表示自动探测。
    tool_path: Mutex<Option<String>>,
}

impl AppState {
    /// 创建初始状态（无项目、未配置工具路径）。
    fn new() -> Self {
        AppState {
            project: Mutex::new(None),
            tool_path: Mutex::new(None),
        }
    }
}

/// 打开一个 `.abc` / `.hap` / `.har` 文件。
///
/// 反编译成功后替换当前项目，并返回项目树根节点供前端渲染。
///
/// # Errors
/// 文件不存在、格式不支持、`ark_disasm` 不可用或反编译失败时，
/// 返回可直接展示给用户的中文错误信息；此时保留原项目不变。
#[tauri::command]
fn open_project(path: String, state: State<AppState>) -> Result<TreeNode, String> {
    let configured = state.tool_path.lock().unwrap().clone();
    let p = Project::open(std::path::Path::new(&path), configured.as_deref())?;
    let tree = p.tree().clone();
    *state.project.lock().unwrap() = Some(p);
    Ok(tree)
}

/// 关闭当前项目并释放其占用的内存。
#[tauri::command]
fn close_project(state: State<AppState>) {
    *state.project.lock().unwrap() = None;
}

/// 获取指定节点的内容切片（类 / 方法 / 单元概览）。
///
/// # Errors
/// 无已打开项目或节点 ID 无效时返回错误信息。
#[tauri::command]
fn get_content(node_id: u32, state: State<AppState>) -> Result<NodeContent, String> {
    let guard = state.project.lock().unwrap();
    let p = guard.as_ref().ok_or("没有已打开的项目")?;
    p.content(node_id)
}

/// 配置官方 `ark_disasm` 可执行文件路径。
///
/// - 传入 `Some(path)`：校验路径可用后保存；
/// - 传入 `None` / 空串：清除配置并回退到自动探测（探测失败会报错）。
///
/// 返回 `Ok(true)` 表示配置生效。
#[tauri::command]
fn set_disassembler_path(path: Option<String>, state: State<AppState>) -> Result<bool, String> {
    match &path {
        Some(p) if !p.trim().is_empty() => {
            let resolved = runner::locate(Some(p))?;
            *state.tool_path.lock().unwrap() = Some(resolved.to_string_lossy().to_string());
        }
        _ => {
            // 清除配置并验证自动探测仍然可用
            let resolved = runner::locate(None)?;
            *state.tool_path.lock().unwrap() = None;
            let _ = resolved;
        }
    }
    Ok(true)
}

/// Tauri 应用入口：注册插件、状态与命令后启动主窗口。
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::new())
        .invoke_handler(tauri::generate_handler![
            open_project,
            close_project,
            get_content,
            set_disassembler_path
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
