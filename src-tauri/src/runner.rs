//! 官方反编译工具 `ark_disasm` 的定位与调用封装。
//!
//! abcde 不自行解析字节码，而是调用 OpenHarmony 官方工具链中的
//! `ark_disasm` 将 `.abc` 反编译为标准 `.pa` 文本，保证输出与官方一致。
//! 同时尝试附带 `--dump-literal-pools` 输出，为 ArkTS 还原提供
//! 调用目标名称解析所需的字面量池信息。

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::decompiler::{parse_literal_names, LiteralNames};

/// 按优先级定位官方 `ark_disasm` 可执行文件。
///
/// 探测顺序：
/// 1. 用户在设置中配置的路径（`configured`）；
/// 2. `ABCDE_ARK_DISASM` 环境变量；
/// 3. 应用自身可执行文件所在目录（随包分发的 sidecar）；
/// 4. 系统 `PATH` 环境变量中的各个目录。
///
/// 返回第一个实际存在的可执行文件路径；全部未命中时返回带提示的错误。
pub fn locate(configured: Option<&str>) -> Result<PathBuf, String> {
    let mut candidates: Vec<PathBuf> = Vec::new();

    if let Some(p) = configured {
        if !p.trim().is_empty() {
            candidates.push(PathBuf::from(p));
        }
    }
    if let Ok(env_path) = std::env::var("ABCDE_ARK_DISASM") {
        if !env_path.trim().is_empty() {
            candidates.push(PathBuf::from(env_path));
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            for name in exe_names() {
                candidates.push(dir.join(name));
            }
        }
    }
    if let Ok(path_var) = std::env::var("PATH") {
        for dir in std::env::split_paths(&path_var) {
            for name in exe_names() {
                candidates.push(dir.join(name));
            }
        }
    }

    for c in candidates {
        if c.is_file() {
            return Ok(c);
        }
    }
    Err(
        "未找到 ark_disasm。请在设置中配置官方 ark_disasm 路径，\
         或将其放入应用目录 / PATH 环境变量。"
            .into(),
    )
}

/// 按当前平台返回候选可执行文件名（Windows 优先 `.exe`）。
fn exe_names() -> [&'static str; 2] {
    if cfg!(windows) {
        ["ark_disasm.exe", "ark_disasm"]
    } else {
        ["ark_disasm", "ark_disasm.exe"]
    }
}

/// 反编译并尝试附带字面量池 dump，返回 `(pa 全文, 名称表)`。
///
/// 先以 `--dump-literal-pools` 运行（旧版工具不认识该参数时会失败），
/// 失败时回退到普通调用并返回空名称表。
pub fn disassemble_with_names(tool: &Path, abc_path: &Path) -> Result<(String, LiteralNames), String> {
    match run_once(tool, &["--dump-literal-pools"], abc_path) {
        Ok(text) => {
            let names = parse_literal_names(&text);
            Ok((text, names))
        }
        Err(_) => {
            let text = run_once(tool, &[], abc_path)?;
            Ok((text, LiteralNames::default()))
        }
    }
}

/// 执行一次 ark_disasm 并读回输出文本。
fn run_once(tool: &Path, extra_args: &[&str], abc_path: &Path) -> Result<String, String> {
    let out_dir = temp_work_dir()?;
    let pa_path = out_dir.join("output.pa");

    let mut cmd = Command::new(tool);
    for a in extra_args {
        cmd.arg(a);
    }
    cmd.arg(abc_path).arg(&pa_path);

    let output = cmd
        .output()
        .map_err(|e| format!("启动 ark_disasm 失败: {e}"))?;

    let stderr = String::from_utf8_lossy(&output.stderr);
    let pa = if pa_path.is_file() {
        std::fs::read_to_string(&pa_path).unwrap_or_default()
    } else {
        String::new()
    };
    let _ = std::fs::remove_dir_all(&out_dir);

    if !output.status.success() && pa.is_empty() {
        return Err(format!(
            "ark_disasm 执行失败 (exit {:?}):\n{}",
            output.status.code(),
            stderr.trim()
        ));
    }

    if pa.trim().is_empty() {
        return Err("ark_disasm 未产生输出".into());
    }

    Ok(pa)
}

/// 在系统临时目录下创建一次性的工作目录，名称含纳秒时间戳保证唯一。
fn temp_work_dir() -> Result<PathBuf, String> {
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_nanos();
    let dir = std::env::temp_dir().join(format!("abcde-{ts}"));
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建临时目录失败: {e}"))?;
    Ok(dir)
}
