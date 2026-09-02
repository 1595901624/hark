//! Hark 库入口：注册 Tauri 插件、共享状态与前端可调用的命令。
//!
//! 命令一览：
//! - [`open_project`]：打开 `.abc` / `.hap` / `.har` / `.hark` 并返回项目树；
//! - [`save_project_hark`]：把当前项目与工作区快照保存为 `.hark` 文件；
//! - [`get_content`]：按节点 ID 获取内容切片（支持 abc / ets 双视图）；
//! - [`export_node_ets`]：把节点的 ArkTS 还原结果导出为文件；
//! - [`export_node_pa`]：把节点的反汇编文本导出为 `.pa` 文件；
//! - [`export_project_abc`]：把项目包含的全部原始 `.abc` 字节码批量导出到目录；
//! - [`export_project_pa`]：按项目树结构把全部类反汇编批量导出为 `.pa` 文件；
//! - [`close_project`]：关闭当前项目；
//! - [`set_disassembler_path`]：配置官方 `ark_disasm` 路径（保存前执行
//!   `--version` 校验）；
//! - [`disassembler_version`]：获取 `ark_disasm` 版本信息；
//! - [`search_project`]：全局多类别搜索（类 / 方法 / 字段 / 字符串 / 代码 / 资源）。

pub mod decompiler;
pub mod hark;
pub mod pa;
mod project;
mod runner;
pub mod search;

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use project::{MethodLocation, NodeContent, Project, TreeNode};
use serde::Serialize;
use tauri::{Manager, State};

/// 应用共享状态：当前项目 + 反编译工具路径配置 + 搜索/打开取消代次。
struct AppState {
    /// 当前打开的项目；`None` 表示未打开。
    project: Mutex<Option<Project>>,
    /// 用户配置的 `ark_disasm` 路径；`None` 表示自动探测。
    tool_path: Mutex<Option<String>>,
    /// 随应用分发的内置 `ark_disasm` 完整路径（资源目录下按平台子目录定位）；
    /// 启动时解析一次。资源解析失败时为 `None`（仅影响探测候选，不致命）。
    bundled_tool: Mutex<Option<PathBuf>>,
    /// 搜索代次计数器：每次发起新搜索递增，旧搜索据此自行终止。
    search_generation: AtomicU64,
    /// 打开项目代次计数器：每次发起新打开或取消时递增，
    /// 正在进行的打开任务检测到代次变化即提前终止。
    open_generation: AtomicU64,
}

impl AppState {
    /// 创建初始状态（无项目、未配置工具路径）。
    fn new() -> Self {
        AppState {
            project: Mutex::new(None),
            tool_path: Mutex::new(None),
            bundled_tool: Mutex::new(None),
            search_generation: AtomicU64::new(0),
            open_generation: AtomicU64::new(0),
        }
    }
}

/// 解析随应用分发的内置 `ark_disasm` 路径。
///
/// 资源目录布局按平台与 CPU 架构分目录：
/// `resources/bin/<平台>/<架构>/<可执行名>`
/// - Windows (仅 64 位): `resources/bin/windows/x86_64/ark_disasm.exe`
/// - macOS (arm + x86): `resources/bin/macos/{aarch64|x86_64}/ark_disasm`
/// - Linux (仅 x86): `resources/bin/linux/x86_64/ark_disasm`
///
/// 开发模式下资源目录即 `src-tauri`，与打包后的安装布局一致，
/// 因此开发与生产使用同一相对路径。解析失败时返回 `None`。
fn resolve_bundled_tool(app: &tauri::AppHandle) -> Option<PathBuf> {
    let platform = if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else {
        "linux"
    };
    let arch = if cfg!(target_arch = "aarch64") {
        "aarch64"
    } else if cfg!(target_arch = "x86_64") {
        "x86_64"
    } else if cfg!(target_arch = "x86") {
        "x86"
    } else {
        return None;
    };
    let exe = if cfg!(windows) {
        "ark_disasm.exe"
    } else {
        "ark_disasm"
    };
    app.path()
        .resolve(
            format!("resources/bin/{platform}/{arch}/{exe}"),
            tauri::path::BaseDirectory::Resource,
        )
        .ok()
}

/// [`open_project`] 的返回值：项目树 + 可选的 `.hark` 会话元数据。
#[derive(Serialize)]
struct OpenProjectResult {
    /// 项目树根节点。
    tree: TreeNode,
    /// 打开 `.hark` 时解出的会话元数据（含工作区快照）；普通文件为 `None`。
    session: Option<hark::HarkMeta>,
}

/// 打开一个 `.abc` / `.hap` / `.har` 文件，或 `.hark` 工作区文件。
///
/// 打开 `.hark` 时先校验完整性（CRC32 + SHA-256），再加载其引用的源文件；
/// 源文件不存在或已被移动时返回明确错误。反编译成功后替换当前项目。
///
/// 重活在 `spawn_blocking` 线程执行，不阻塞 Tauri 事件循环（窗口可拖动）。
/// 用户可通过 [`cancel_open_project`] 取消正在进行的打开。
///
/// # Errors
/// 文件不存在、格式不支持、`.hark` 校验失败、`ark_disasm` 不可用或
/// 反编译失败时，返回可直接展示给用户的中文错误信息；此时保留原项目不变。
/// 被取消时返回 `"cancelled"`。
#[tauri::command]
async fn open_project(path: String, app: tauri::AppHandle) -> Result<OpenProjectResult, String> {
    let path = std::path::Path::new(&path);
    let ext = path
        .extension()
        .map(|e| e.to_ascii_lowercase().to_string_lossy().to_string())
        .unwrap_or_default();

    // `.hark`：先校验并解出会话元数据，再按其中记录的源文件打开
    let session = if ext == "hark" {
        Some(hark::load(path)?)
    } else {
        None
    };
    let open_path = session
        .as_ref()
        .map(|m| std::path::PathBuf::from(&m.project.source_path))
        .unwrap_or_else(|| path.to_path_buf());
    if !open_path.exists() {
        return Err(format!("源文件不存在或已被移动: {}", open_path.display()));
    }

    let state = app.state::<AppState>();
    let configured = state.tool_path.lock().unwrap().clone();
    let bundled = state.bundled_tool.lock().unwrap().clone();
    // 发起新打开：代次 +1；打开过程中检测到代次变化即提前退出
    let my_generation = state.open_generation.fetch_add(1, Ordering::SeqCst) + 1;

    let app_for_blocking = app.clone();
    let open_path_clone = open_path.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let inner_state = app_for_blocking.state::<AppState>();
        let is_cancelled = || inner_state.open_generation.load(Ordering::SeqCst) != my_generation;
        Project::open(
            &open_path_clone,
            configured.as_deref(),
            bundled.as_deref(),
            &is_cancelled,
        )
    })
    .await
    .map_err(|e| format!("打开任务执行失败: {e}"))?;

    // 最终交换前再做一次代次检查，避免与取消/新打开竞态
    if state.open_generation.load(Ordering::SeqCst) != my_generation {
        return Err("cancelled".into());
    }

    let p = result?;
    let tree = p.tree().clone();
    *state.project.lock().unwrap() = Some(p);
    Ok(OpenProjectResult { tree, session })
}

/// 取消正在进行的打开项目操作。
///
/// 抬高打开代次，使正在 `spawn_blocking` 中运行的 `Project::open`
/// 检测到代次变化后提前终止并返回 `"cancelled"`。
#[tauri::command]
fn cancel_open_project(app: tauri::AppHandle) {
    let state = app.state::<AppState>();
    state.open_generation.fetch_add(1, Ordering::SeqCst);
}

/// 关闭当前项目并释放其占用的内存。
#[tauri::command]
fn close_project(state: State<AppState>) {
    *state.project.lock().unwrap() = None;
}

/// 把当前打开的项目与前端提供的工作区快照保存为 `.hark` 文件。
///
/// 项目信息（名称 / 类型 / 源文件路径）由后端从当前 [`Project`] 提取，
/// `workspace` 为前端整理的标签与激活状态快照。
///
/// # Errors
/// 无已打开项目、路径为空或写入失败时返回中文错误信息。
#[tauri::command]
fn save_project_hark(
    path: String,
    workspace: Option<hark::SavedWorkspace>,
    state: State<AppState>,
) -> Result<(), String> {
    if path.trim().is_empty() {
        return Err("保存路径为空".into());
    }
    let guard = state.project.lock().unwrap();
    let p = guard.as_ref().ok_or("没有已打开的项目")?;

    let meta = hark::HarkMeta {
        app: env!("CARGO_PKG_NAME").to_string(),
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        saved_at_ms: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|e| format!("获取系统时间失败: {e}"))?
            .as_millis() as u64,
        project: hark::ProjectInfo {
            name: p.name.clone(),
            kind: p.kind.clone(),
            source_path: p.source_path.to_string_lossy().to_string(),
        },
        workspace: workspace.unwrap_or_default(),
    };
    hark::save(std::path::Path::new(&path), &meta)
}

/// 获取指定节点的内容切片（类 / 方法 / 单元概览）。
///
/// `view`：`"abc"`（默认）返回 pandasm 反汇编文本；
/// `"ets"` 返回 ArkTS 还原结果。
///
/// # Errors
/// 无已打开项目或节点 ID 无效时返回错误信息。
#[tauri::command]
fn get_content(
    node_id: u32,
    view: Option<String>,
    state: State<AppState>,
) -> Result<NodeContent, String> {
    let view = view.as_deref().unwrap_or("abc");
    let guard = state.project.lock().unwrap();
    let p = guard.as_ref().ok_or("没有已打开的项目")?;
    p.content(node_id, view)
}

/// 定位方法节点在其所属类内容中的行位置（点击方法跳转到类内声明处）。
///
/// 返回所属类节点 ID 与 abc / ets 视图中方法声明所在行号。
///
/// # Errors
/// 无已打开项目、节点不是方法节点或定位失败时返回错误信息。
#[tauri::command]
fn method_location(node_id: u32, state: State<AppState>) -> Result<MethodLocation, String> {
    let guard = state.project.lock().unwrap();
    let p = guard.as_ref().ok_or("没有已打开的项目")?;
    p.method_location(node_id)
}

/// 把指定节点的 ArkTS 还原结果导出为 `.ets` 文件。
///
/// 内容与前端 `.ets` 视图完全一致；目标目录不存在时自动创建。
///
/// # Errors
/// 无已打开项目、节点无效或写入失败时返回中文错误信息。
#[tauri::command]
fn export_node_ets(node_id: u32, path: String, state: State<AppState>) -> Result<(), String> {
    if path.trim().is_empty() {
        return Err("导出路径为空".into());
    }
    let guard = state.project.lock().unwrap();
    let p = guard.as_ref().ok_or("没有已打开的项目")?;
    p.export_ets(node_id, std::path::Path::new(&path))
}

/// 导出指定节点的反汇编文本（abc 视图）为 `.pa` 文件。
///
/// 内容与前端 `.abc` 视图完全一致；目标目录不存在时自动创建。
///
/// # Errors
/// 无已打开项目、节点无效或写入失败时返回中文错误信息。
#[tauri::command]
fn export_node_pa(node_id: u32, path: String, state: State<AppState>) -> Result<(), String> {
    if path.trim().is_empty() {
        return Err("导出路径为空".into());
    }
    let guard = state.project.lock().unwrap();
    let p = guard.as_ref().ok_or("没有已打开的项目")?;
    p.export_pa(node_id, std::path::Path::new(&path))
}

/// 导出指定图片资源节点的原始字节到目标路径。
///
/// 从压缩包中读取图片的原始字节（未经 base64 编码）直接写盘，保留原始格式与质量。
/// 仅对图片类型（`.png` / `.jpg` / `.jpeg` / `.webp`）的资源节点有效。
///
/// # Errors
/// 无已打开项目、节点无效、非图片资源或写盘失败时返回中文错误信息。
#[tauri::command]
fn export_node_image(node_id: u32, path: String, state: State<AppState>) -> Result<(), String> {
    if path.trim().is_empty() {
        return Err("导出路径为空".into());
    }
    let guard = state.project.lock().unwrap();
    let p = guard.as_ref().ok_or("没有已打开的项目")?;
    p.export_image(node_id, std::path::Path::new(&path))
}

/// 把当前项目包含的全部原始 `.abc` 字节码批量导出到目标目录。
///
/// 文件写入 `<dir>/<项目名去扩展名>/` 子目录：`.abc` 项目直接复制源文件；
/// 压缩包项目从源文件重新提取全部 `.abc` 条目并按包内相对路径保存。
///
/// # Errors
/// 无已打开项目、路径为空、无 `.abc` 可导出或写盘失败时返回中文错误信息。
#[tauri::command]
fn export_project_abc(dir: String, state: State<AppState>) -> Result<Vec<String>, String> {
    if dir.trim().is_empty() {
        return Err("导出路径为空".into());
    }
    let guard = state.project.lock().unwrap();
    let p = guard.as_ref().ok_or("没有已打开的项目")?;
    p.export_abc_all(std::path::Path::new(dir.trim()))
}

/// 按项目树结构把当前项目全部类的反汇编文本批量导出为 `.pa` 文件到目标目录。
///
/// 在 `<dir>/<项目名>/` 下镜像左侧项目树：包名作为一层层文件夹，每个类作为
/// 单独的 `.pa` 文件（内容为该类的完整 pandasm 反汇编，与 `.abc` 视图一致）。
/// 多单元项目按 `.abc` 单元建子目录，同名类自动去重。
///
/// # Errors
/// 无已打开项目、路径为空、无可导出内容或写盘失败时返回中文错误信息。
#[tauri::command]
fn export_project_pa(dir: String, state: State<AppState>) -> Result<Vec<String>, String> {
    if dir.trim().is_empty() {
        return Err("导出路径为空".into());
    }
    let guard = state.project.lock().unwrap();
    let p = guard.as_ref().ok_or("没有已打开的项目")?;
    p.export_pa_all(std::path::Path::new(dir.trim()))
}

/// 配置官方 `ark_disasm` 可执行文件路径。
///
/// - 传入 `Some(path)`：要求该路径指向实际存在的文件，并执行
///   `--version` 验证可运行；任一环节失败则返回错误、**不保存**；
/// - 传入 `None` / 空串：清除配置并回退到自动探测（含内置副本），
///   探测结果同样必须通过 `--version` 校验。
///
/// 返回 `Ok(true)` 表示配置生效。
#[tauri::command]
fn set_disassembler_path(path: Option<String>, state: State<AppState>) -> Result<bool, String> {
    let bundled = state.bundled_tool.lock().unwrap().clone();
    match &path {
        Some(p) if !p.trim().is_empty() => {
            let candidate = PathBuf::from(p.trim());
            if !candidate.is_file() {
                return Err(format!("文件不存在: {}", candidate.display()));
            }
            // 切换反编译器前先验证可执行性，失败则保持原配置不变
            runner::run_version(&candidate)?;
            *state.tool_path.lock().unwrap() = Some(candidate.to_string_lossy().to_string());
        }
        _ => {
            // 清除配置：自动探测（内置副本 → exe 目录 → PATH）必须可用且通过校验
            let tool = runner::locate(None, bundled.as_deref())?;
            runner::run_version(&tool)?;
            *state.tool_path.lock().unwrap() = None;
        }
    }
    Ok(true)
}

/// 获取 `ark_disasm` 的版本信息（对其执行 `--version`）。
///
/// - 传入 `Some(path)`：直接对指定路径的二进制执行；
/// - 传入 `None` / 空串：按自动探测顺序（环境变量 → 内置副本 →
///   exe 目录 → PATH）定位后执行，用于展示当前生效工具的版本。
///
/// # Errors
/// 文件不存在、启动失败或 `--version` 执行失败时返回中文错误信息。
#[tauri::command]
fn disassembler_version(path: Option<String>, state: State<AppState>) -> Result<String, String> {
    let bundled = state.bundled_tool.lock().unwrap().clone();
    let tool = match path.as_deref().map(str::trim) {
        Some(p) if !p.is_empty() => {
            let candidate = PathBuf::from(p);
            if !candidate.is_file() {
                return Err(format!("文件不存在: {}", candidate.display()));
            }
            candidate
        }
        _ => runner::locate(None, bundled.as_deref())?,
    };
    runner::run_version(&tool)
}

/// 全局搜索当前打开的项目（后台线程执行，避免阻塞主线程）。
///
/// 前端连续输入时旧搜索会因代次变化自行取消，返回 `cancelled: true` 的
/// 空结果，前端可直接忽略。
///
/// # Errors
/// 无已打开项目或搜索参数非法时返回中文错误信息。
#[tauri::command]
async fn search_project(
    options: search::SearchOptions,
    app: tauri::AppHandle,
) -> Result<search::SearchResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        // 发起新搜索：代次 +1；扫描过程中检测到代次变化即提前退出
        let my_generation = state.search_generation.fetch_add(1, Ordering::SeqCst) + 1;
        let guard = state.project.lock().unwrap();
        let project = guard.as_ref().ok_or("没有已打开的项目")?;
        let is_cancelled = || state.search_generation.load(Ordering::SeqCst) != my_generation;
        project.search(&options, &is_cancelled)
    })
    .await
    .map_err(|e| format!("搜索任务执行失败: {e}"))?
}

/// Tauri 应用入口：注册插件、状态与命令后启动主窗口。
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::new())
        .setup(|app| {
            // 启动时解析一次内置 ark_disasm 的资源路径，供所有命令共享
            let bundled = resolve_bundled_tool(app.handle());
            *app.state::<AppState>().bundled_tool.lock().unwrap() = bundled;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            open_project,
            cancel_open_project,
            save_project_hark,
            close_project,
            get_content,
            method_location,
            export_node_ets,
            export_node_pa,
            export_node_image,
            export_project_abc,
            export_project_pa,
            set_disassembler_path,
            disassembler_version,
            search_project
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
