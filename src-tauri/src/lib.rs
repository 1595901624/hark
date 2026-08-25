mod pa;
mod project;
mod runner;

use std::sync::Mutex;

use project::{NodeContent, Project, TreeNode};
use tauri::State;

struct AppState {
    project: Mutex<Option<Project>>,
    tool_path: Mutex<Option<String>>,
}

impl AppState {
    fn new() -> Self {
        AppState {
            project: Mutex::new(None),
            tool_path: Mutex::new(None),
        }
    }
}

#[tauri::command]
fn open_project(path: String, state: State<AppState>) -> Result<TreeNode, String> {
    let configured = state.tool_path.lock().unwrap().clone();
    let p = Project::open(std::path::Path::new(&path), configured.as_deref())?;
    let tree = p.tree().clone();
    *state.project.lock().unwrap() = Some(p);
    Ok(tree)
}

#[tauri::command]
fn close_project(state: State<AppState>) {
    *state.project.lock().unwrap() = None;
}

#[tauri::command]
fn get_content(node_id: u32, state: State<AppState>) -> Result<NodeContent, String> {
    let guard = state.project.lock().unwrap();
    let p = guard.as_ref().ok_or("没有已打开的项目")?;
    p.content(node_id)
}

#[tauri::command]
fn set_disassembler_path(path: Option<String>, state: State<AppState>) -> Result<bool, String> {
    match &path {
        Some(p) if !p.trim().is_empty() => {
            let resolved = runner::locate(Some(p))?;
            *state.tool_path.lock().unwrap() = Some(resolved.to_string_lossy().to_string());
        }
        _ => {
            // clear and verify auto-detection still works
            let resolved = runner::locate(None)?;
            *state.tool_path.lock().unwrap() = None;
            let _ = resolved;
        }
    }
    Ok(true)
}

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
