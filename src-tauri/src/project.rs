use std::collections::HashMap;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::pa::{PaFile, PaRecord};
use crate::runner;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum NodeKind {
    Root,
    Abc,
    Package,
    Class,
    Method,
    ResourceDir,
    Resource,
}

#[derive(Debug, Clone, Serialize)]
pub struct TreeNode {
    pub id: u32,
    pub name: String,
    pub kind: NodeKind,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub detail: String,
    pub children: Vec<TreeNode>,
}

enum NodePayload {
    Unit { unit: usize },
    Class { unit: usize, record: usize },
    Method { unit: usize, record: usize, method: usize },
    Resource { entry: usize },
}

struct AbcUnit {
    /// display name, e.g. `modules.abc` or `ets/modules.abc` inside a hap
    name: String,
    pa: PaFile,
}

pub struct Project {
    pub name: String,
    pub kind: String,
    pub source_path: PathBuf,
    units: Vec<AbcUnit>,
    archive_entries: Vec<String>,
    nodes: HashMap<u32, NodePayload>,
    tree: TreeNode,
    next_id: u32,
}

impl Project {
    fn alloc_id(&mut self) -> u32 {
        self.next_id += 1;
        self.next_id
    }

    /// Opens an .abc / .hap / .har file.
    ///
    /// Every contained .abc is disassembled with the official `ark_disasm`
    /// and the resulting standard .pa text is parsed into the project tree.
    pub fn open(path: &Path, tool_path: Option<&str>) -> Result<Project, String> {
        let tool = runner::locate(tool_path)?;
        let file_name = path
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
        let ext = path
            .extension()
            .map(|e| e.to_ascii_lowercase().to_string_lossy().to_string())
            .unwrap_or_default();

        let mut abc_files: Vec<(String, PathBuf)> = vec![];
        let mut archive_entries: Vec<String> = vec![];
        let mut temp_dirs: Vec<PathBuf> = vec![];

        let result = (|| -> Result<(), String> {
            match ext.as_str() {
                "abc" => {
                    abc_files.push((file_name.clone(), path.to_path_buf()));
                }
                "hap" | "har" | "app" | "zip" => {
                    let data = fs::read(path).map_err(|e| format!("读取失败: {e}"))?;
                    let cursor = std::io::Cursor::new(data);
                    let mut archive =
                        zip::ZipArchive::new(cursor).map_err(|e| format!("无效压缩包: {e}"))?;
                    let work_dir = temp_root()?;
                    temp_dirs.push(work_dir.clone());
                    for i in 0..archive.len() {
                        let mut entry = archive
                            .by_index(i)
                            .map_err(|e| format!("压缩包条目 #{i}: {e}"))?;
                        let name = entry.name().to_string();
                        if name.ends_with('/') || entry.is_dir() {
                            continue;
                        }
                        if name.to_ascii_lowercase().ends_with(".abc") {
                            let target_dir = work_dir.join(sanitize_component(&name));
                            fs::create_dir_all(&target_dir)
                                .map_err(|e| format!("创建目录失败: {e}"))?;
                            let target = target_dir.join("entry.abc");
                            let mut bytes = Vec::new();
                            entry.read_to_end(&mut bytes).map_err(|e| format!("读取 `{name}`: {e}"))?;
                            fs::write(&target, &bytes).map_err(|e| format!("写入临时文件失败: {e}"))?;
                            abc_files.push((name, target));
                        } else {
                            archive_entries.push(name);
                        }
                    }
                }
                other => return Err(format!("不支持的文件类型: .{other}")),
            }
            Ok(())
        })();

        // Always clean up temp dirs after disassembly finishes (or fails).
        let outcome = result.and_then(|()| {
            if abc_files.is_empty() {
                return Err("该文件中没有找到 .abc 字节码".into());
            }
            let mut units = Vec::with_capacity(abc_files.len());
            for (name, abc_path) in &abc_files {
                let text = runner::disassemble(&tool, abc_path)?;
                units.push(AbcUnit {
                    name: name.clone(),
                    pa: PaFile::parse(&text),
                });
            }
            Ok(units)
        });

        for dir in temp_dirs {
            let _ = fs::remove_dir_all(dir);
        }

        let units = outcome?;

        let mut project = Project {
            name: file_name,
            kind: ext,
            source_path: path.to_path_buf(),
            units,
            archive_entries,
            nodes: HashMap::new(),
            tree: TreeNode {
                id: 0,
                name: String::new(),
                kind: NodeKind::Root,
                detail: String::new(),
                children: vec![],
            },
            next_id: 0,
        };
        project.build_tree();
        Ok(project)
    }

    fn build_tree(&mut self) {
        let root_id = self.alloc_id();
        let mut root = TreeNode {
            id: root_id,
            name: self.name.clone(),
            kind: NodeKind::Root,
            detail: self.kind.clone(),
            children: vec![],
        };

        for ui in 0..self.units.len() {
            let (short_name, num_records) = {
                let unit = &self.units[ui];
                let short = unit.name.rsplit('/').next().unwrap_or(&unit.name).to_string();
                (short, unit.pa.records.len())
            };
            let unit_id = self.alloc_id();
            self.nodes.insert(unit_id, NodePayload::Unit { unit: ui });
            let mut unit_node = TreeNode {
                id: unit_id,
                name: short_name,
                kind: NodeKind::Abc,
                detail: format!("{num_records} classes"),
                children: vec![],
            };

            // package hierarchy from record names
            let mut package_root = PackageNode::default();
            for ri in 0..num_records {
                let display = self.units[ui].pa.records[ri].display_name.clone();
                insert_record(&mut package_root, &display, ri);
            }
            flatten_packages(self, &mut package_root, ui, &mut unit_node.children, String::new());

            root.children.push(unit_node);
        }

        if !self.archive_entries.is_empty() {
            let res_dir_id = self.alloc_id();
            let res_dir = TreeNode {
                id: res_dir_id,
                name: "resources".into(),
                kind: NodeKind::ResourceDir,
                detail: format!("{} files", self.archive_entries.len()),
                children: build_resource_tree(self),
            };
            root.children.push(res_dir);
        }

        self.tree = root;
    }

    pub fn tree(&self) -> &TreeNode {
        &self.tree
    }

    pub fn content(&self, node_id: u32) -> Result<NodeContent, String> {
        match self.nodes.get(&node_id) {
            Some(NodePayload::Unit { unit }) => {
                let u = &self.units[*unit];
                Ok(NodeContent {
                    title: u.name.clone(),
                    language: "text".into(),
                    body: format!(
                        "# {}\n# {} records\n\n展开左侧节点浏览包与类；点击类查看反编译内容。\n",
                        u.name,
                        u.pa.records.len(),
                    ),
                })
            }
            Some(NodePayload::Class { unit, record }) => {
                let pa = &self.units[*unit].pa;
                let body = pa.render_record(*record).ok_or("record missing")?;
                Ok(NodeContent {
                    title: pa.records[*record].display_name.clone(),
                    language: "asm".into(),
                    body,
                })
            }
            Some(NodePayload::Method { unit, record, method }) => {
                let u = &self.units[*unit];
                let rec = u.pa.records.get(*record).ok_or("record missing")?;
                let m = rec.methods.get(*method).ok_or("method missing")?;
                let mut body = String::new();
                body.push_str(&format!(".function {}\n{{\n", m.signature));
                for line in &m.body {
                    body.push_str(line);
                    body.push('\n');
                }
                body.push_str("}\n");
                Ok(NodeContent {
                    title: format!("{}.{}", rec.display_name, m.name),
                    language: "asm".into(),
                    body,
                })
            }
            Some(NodePayload::Resource { entry }) => {
                let name = self
                    .archive_entries
                    .get(*entry)
                    .cloned()
                    .unwrap_or_default();
                Ok(NodeContent {
                    title: name,
                    language: "text".into(),
                    body: "(资源文件预览将在后续版本提供)".into(),
                })
            }
            None => Err(format!("未知节点 #{node_id}")),
        }
    }
}

fn temp_root() -> Result<PathBuf, String> {
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_nanos();
    let dir = std::env::temp_dir().join(format!("abcde-{ts}"));
    fs::create_dir_all(&dir).map_err(|e| format!("创建临时目录失败: {e}"))?;
    Ok(dir)
}

/// Turns an archive entry path into a safe single filesystem component chain.
fn sanitize_component(name: &str) -> String {
    name.split('/')
        .filter(|s| !s.is_empty() && *s != ".." && *s != ".")
        .collect::<Vec<_>>()
        .join("__")
}

#[derive(Default)]
struct PackageNode {
    children: std::collections::BTreeMap<String, PackageNode>,
    records: Vec<usize>,
}

fn insert_record(root: &mut PackageNode, display_name: &str, record_idx: usize) {
    let segments: Vec<&str> = display_name.split('.').collect();
    if segments.len() <= 1
        || display_name.is_empty()
        || display_name.starts_with('<')
        || display_name.contains(' ')
    {
        root.records.push(record_idx);
        return;
    }
    let mut node = root;
    for seg in &segments[..segments.len() - 1] {
        node = node.children.entry((*seg).to_string()).or_default();
    }
    node.records.push(record_idx);
}

fn flatten_packages(
    project: &mut Project,
    node: &PackageNode,
    unit: usize,
    out: &mut Vec<TreeNode>,
    prefix: String,
) {
    for (name, child) in &node.children {
        let id = project.alloc_id();
        let full = if prefix.is_empty() {
            name.clone()
        } else {
            format!("{prefix}.{name}")
        };
        let mut tn = TreeNode {
            id,
            name: name.clone(),
            kind: NodeKind::Package,
            detail: String::new(),
            children: vec![],
        };
        let mut sub_out = vec![];
        flatten_packages(project, child, unit, &mut sub_out, full);
        tn.children = sub_out;
        out.push(tn);
    }
    for ri in &node.records {
        let (short, method_names) = {
            let rec: &PaRecord = &project.units[unit].pa.records[*ri];
            let short = rec
                .display_name
                .rsplit('.')
                .next()
                .unwrap_or(&rec.display_name)
                .to_string();
            let names = rec.methods.iter().map(|m| m.name.clone()).collect::<Vec<_>>();
            (short, names)
        };
        let id = project.alloc_id();
        let mut tn = TreeNode {
            id,
            name: short,
            kind: NodeKind::Class,
            detail: format!("{} methods", method_names.len()),
            children: vec![],
        };
        project.nodes.insert(id, NodePayload::Class { unit, record: *ri });
        for (mi, mname) in method_names.iter().enumerate() {
            let mid = project.alloc_id();
            tn.children.push(TreeNode {
                id: mid,
                name: mname.clone(),
                kind: NodeKind::Method,
                detail: String::new(),
                children: vec![],
            });
            project
                .nodes
                .insert(mid, NodePayload::Method { unit, record: *ri, method: mi });
        }
        out.push(tn);
    }
}

fn build_resource_tree(project: &mut Project) -> Vec<TreeNode> {
    let entries = project.archive_entries.clone();
    let mut out = vec![];
    for (i, path) in entries.iter().enumerate() {
        let id = project.alloc_id();
        out.push(TreeNode {
            id,
            name: path.rsplit('/').next().unwrap_or(path).to_string(),
            kind: NodeKind::Resource,
            detail: match path.rfind('/') {
                Some(pos) => path[..pos].to_string(),
                None => String::new(),
            },
            children: vec![],
        });
        project.nodes.insert(id, NodePayload::Resource { entry: i });
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

#[derive(Debug, Clone, Serialize)]
pub struct NodeContent {
    pub title: String,
    pub language: String,
    pub body: String,
}
