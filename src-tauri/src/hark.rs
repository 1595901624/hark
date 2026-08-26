//! `.hark` 工作区文件格式（Harmony + Ark）。
//!
//! 用于把「当前打开的项目 + 工作区状态」保存为单个二进制文件，重新打开时
//! 可恢复标签与视图现场。格式为仅引用源文件路径的轻量容器：
//!
//! ```text
//! "HARK"          魔数，4 字节
//! version: u16    格式版本（LE），当前为 1
//! flags: u16      保留字段，恒为 0
//! meta_len: u32   META 分段字节数（LE）
//! meta_bytes      META 分段：UTF-8 编码的 JSON 快照
//! crc32: u32      META 分段的 CRC32 校验值（LE），快速完整性检查
//! sha256: [u8;32] 以上全部字节的 SHA-256 摘要，防篡改
//! ```
//!
//! 加载时依次校验魔数 → 版本 → 总长度 → CRC32 → SHA-256，任一不符即拒绝。

use std::{fs, path::Path};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// 文件魔数。
pub const MAGIC: &[u8; 4] = b"HARK";

/// 当前格式版本。
pub const FORMAT_VERSION: u16 = 1;

/// 头部固定长度：魔数(4) + 版本(2) + 保留(2) + meta_len(4)。
const HEADER_LEN: usize = 12;

/// 尾部长度：crc32(4) + sha256(32)。
const TRAILER_LEN: usize = 36;

/// 工作区快照中单个已打开标签的恢复信息。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedTab {
    /// 项目树节点 ID（同一源文件反编译树的 ID 分配是确定性的）。
    pub node_id: u32,
    /// 该标签激活的内容视图：`abc` / `ets`；未知值回退为 `abc`。
    #[serde(default = "default_view")]
    pub view: String,
}

fn default_view() -> String {
    "abc".into()
}

/// 工作区快照：已打开标签列表 + 激活标签。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedWorkspace {
    /// 按保存时的顺序记录的标签列表。
    #[serde(default)]
    pub tabs: Vec<SavedTab>,
    /// 激活标签对应的节点 ID；无激活标签时为 `None`。
    #[serde(default)]
    pub active_node_id: Option<u32>,
}

/// 快照中记录的源项目信息。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectInfo {
    /// 项目名（打开文件的文件名）。
    pub name: String,
    /// 文件扩展名小写形式（`abc` / `hap` / `har` ...）。
    pub kind: String,
    /// 打开文件的绝对路径（`.hark` 仅引用路径，不内嵌字节码）。
    pub source_path: String,
}

/// `.hark` 文件的完整元数据（META JSON 的结构）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HarkMeta {
    /// 生成该文件的应用名。
    pub app: String,
    /// 应用版本号。
    pub app_version: String,
    /// 保存时刻的 Unix 时间戳（毫秒）。
    pub saved_at_ms: u64,
    /// 源项目信息。
    pub project: ProjectInfo,
    /// 工作区快照。
    pub workspace: SavedWorkspace,
}

/// 把 [`HarkMeta`] 序列化并写入 `.hark` 文件。
///
/// 先写入同目录临时文件再改名，避免中途失败留下半截文件。
///
/// # Errors
/// 序列化失败或磁盘读写失败时返回中文错误信息。
pub fn save(path: &Path, meta: &HarkMeta) -> Result<(), String> {
    let meta_bytes =
        serde_json::to_vec_pretty(meta).map_err(|e| format!("序列化工作区数据失败: {e}"))?;

    let mut buf = Vec::with_capacity(HEADER_LEN + meta_bytes.len() + TRAILER_LEN);
    buf.extend_from_slice(MAGIC);
    buf.extend_from_slice(&FORMAT_VERSION.to_le_bytes());
    buf.extend_from_slice(&0u16.to_le_bytes());
    buf.extend_from_slice(&(meta_bytes.len() as u32).to_le_bytes());
    buf.extend_from_slice(&meta_bytes);
    buf.extend_from_slice(&crc32(&meta_bytes).to_le_bytes());
    buf.extend_from_slice(&sha256(&buf));

    // 原子写入：先写临时文件，成功后替换目标
    let file_name = path
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| ".hark".into());
    let tmp = path.with_file_name(format!("{file_name}.tmp"));
    let write_result = (|| {
        fs::write(&tmp, &buf).map_err(|e| format!("写入 {tmp:?} 失败: {e}"))?;
        // Windows 上 rename 不能覆盖已存在文件，先移除旧文件
        if path.exists() {
            fs::remove_file(path).map_err(|e| format!("替换 {path:?} 失败: {e}"))?;
        }
        fs::rename(&tmp, path).map_err(|e| format!("写入 {path:?} 失败: {e}"))
    })();
    if write_result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    write_result
}

/// 读取并校验 `.hark` 文件，返回其中的元数据。
///
/// # Errors
/// 文件不存在、魔数/版本不正确、长度不符、CRC32 或 SHA-256 校验失败、
/// JSON 解析失败时返回中文错误信息。
pub fn load(path: &Path) -> Result<HarkMeta, String> {
    let data = fs::read(path).map_err(|e| format!("读取 {path:?} 失败: {e}"))?;
    if data.len() < HEADER_LEN + TRAILER_LEN {
        return Err("文件过短，不是有效的 .hark 工作区文件".into());
    }
    if &data[0..4] != MAGIC {
        return Err("文件头不正确，不是有效的 .hark 工作区文件".into());
    }
    let version = u16::from_le_bytes([data[4], data[5]]);
    if version != FORMAT_VERSION {
        return Err(format!("暂不支持的工作区版本: {version}"));
    }

    let meta_len = u32::from_le_bytes([data[8], data[9], data[10], data[11]]) as usize;
    if data.len() != HEADER_LEN + meta_len + TRAILER_LEN {
        return Err("文件长度与声明不符，可能已损坏或被修改".into());
    }

    let body_end = HEADER_LEN + meta_len;
    let meta_bytes = &data[HEADER_LEN..body_end];

    let crc_stored = u32::from_le_bytes([
        data[body_end],
        data[body_end + 1],
        data[body_end + 2],
        data[body_end + 3],
    ]);
    if crc32(meta_bytes) != crc_stored {
        return Err("内容校验失败（CRC32 不符）：文件已损坏或被篡改".into());
    }

    let digest_stored = &data[body_end + 4..body_end + TRAILER_LEN];
    let digest_actual = sha256(&data[..body_end + 4]);
    if digest_actual != *digest_stored {
        return Err("完整性校验失败（SHA-256 不符）：文件已被篡改".into());
    }

    serde_json::from_slice(meta_bytes).map_err(|e| format!("工作区数据解析失败: {e}"))
}

/// IEEE CRC-32 校验值（zlib 多项式 0xEDB88320，查表法）。
fn crc32(data: &[u8]) -> u32 {
    use std::sync::OnceLock;
    static TABLE: OnceLock<[u32; 256]> = OnceLock::new();
    let table = TABLE.get_or_init(|| {
        let mut t = [0u32; 256];
        for (i, slot) in t.iter_mut().enumerate() {
            let mut c = i as u32;
            for _ in 0..8 {
                c = if c & 1 != 0 { 0xEDB8_8320 ^ (c >> 1) } else { c >> 1 };
            }
            *slot = c;
        }
        t
    });
    let mut crc = 0xFFFF_FFFFu32;
    for &b in data {
        crc = table[((crc ^ b as u32) & 0xFF) as usize] ^ (crc >> 8);
    }
    crc ^ 0xFFFF_FFFF
}

/// 计算数据的 SHA-256 摘要。
fn sha256(data: &[u8]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(data);
    hasher.finalize().into()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_meta() -> HarkMeta {
        HarkMeta {
            app: "abcde".into(),
            app_version: "0.1.0".into(),
            saved_at_ms: 1_756_000_000_000,
            project: ProjectInfo {
                name: "entry.hap".into(),
                kind: "hap".into(),
                source_path: "D:\\apps\\entry.hap".into(),
            },
            workspace: SavedWorkspace {
                tabs: vec![
                    SavedTab { node_id: 5, view: "abc".into() },
                    SavedTab { node_id: 12, view: "ets".into() },
                ],
                active_node_id: Some(5),
            },
        }
    }

    fn temp_hark(tag: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "abcde-hark-test-{tag}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    #[test]
    fn save_and_load_roundtrip_preserves_meta() {
        let path = temp_hark("roundtrip");
        let meta = sample_meta();
        save(&path, &meta).expect("save should succeed");

        let loaded = load(&path).expect("load should succeed");
        assert_eq!(loaded.app_version, meta.app_version);
        assert_eq!(loaded.project.source_path, meta.project.source_path);
        assert_eq!(loaded.workspace.tabs.len(), 2);
        assert_eq!(loaded.workspace.active_node_id, Some(5));
        assert_eq!(loaded.workspace.tabs[1].view, "ets");

        fs::remove_file(&path).unwrap();
    }

    #[test]
    fn flipped_byte_is_rejected_as_tampered() {
        let path = temp_hark("tamper");
        let meta = sample_meta();
        save(&path, &meta).unwrap();

        let mut bytes = fs::read(&path).unwrap();
        // 翻转 META 中间的一个字节，必须被校验链发现
        let mid = HEADER_LEN + bytes.len() / 4;
        bytes[mid] ^= 0xFF;
        let tampered = temp_hark("tampered-copy");
        fs::write(&tampered, &bytes).unwrap();

        let err = load(&tampered).expect_err("tampered file must be rejected");
        assert!(err.contains("校验失败") || err.contains("篡改") || err.contains("损坏"));

        fs::remove_file(&path).unwrap();
        fs::remove_file(&tampered).unwrap();
    }

    #[test]
    fn wrong_magic_is_rejected() {
        let path = temp_hark("magic");
        save(&path, &sample_meta()).unwrap();

        let mut bytes = fs::read(&path).unwrap();
        bytes[0] = b'X';
        let bad = temp_hark("magic-bad");
        fs::write(&bad, &bytes).unwrap();

        assert!(load(&bad).is_err());

        fs::remove_file(&path).unwrap();
        fs::remove_file(&bad).unwrap();
    }

    #[test]
    fn truncated_file_is_rejected() {
        let path = temp_hark("trunc");
        save(&path, &sample_meta()).unwrap();

        let bytes = fs::read(&path).unwrap();
        let bad = temp_hark("trunc-bad");
        fs::write(&bad, &bytes[..bytes.len() - 10]).unwrap();

        assert!(load(&bad).is_err());

        fs::remove_file(&path).unwrap();
        fs::remove_file(&bad).unwrap();
    }

    #[test]
    fn crc32_matches_known_vectors() {
        assert_eq!(crc32(b""), 0x0000_0000);
        assert_eq!(crc32(b"123456789"), 0xCBF4_3926);
    }
}
