use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

/// Locates the official `ark_disasm` executable:
/// 1. user-configured path (from settings)
/// 2. `ABCDE_ARK_DISASM` environment variable
/// 3. next to our own executable (bundled sidecar)
/// 4. system PATH
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

fn exe_names() -> [&'static str; 2] {
    if cfg!(windows) {
        ["ark_disasm.exe", "ark_disasm"]
    } else {
        ["ark_disasm", "ark_disasm.exe"]
    }
}

/// Runs the official disassembler on an .abc file and returns the .pa text.
pub fn disassemble(tool: &Path, abc_path: &Path) -> Result<String, String> {
    let out_dir = temp_work_dir()?;
    let pa_path = out_dir.join("output.pa");

    let output = Command::new(tool)
        .arg(abc_path)
        .arg(&pa_path)
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

fn temp_work_dir() -> Result<PathBuf, String> {
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_nanos();
    let dir = std::env::temp_dir().join(format!("abcde-{ts}"));
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建临时目录失败: {e}"))?;
    Ok(dir)
}
