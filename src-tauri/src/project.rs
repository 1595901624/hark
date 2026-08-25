//! 项目模型：打开 `.abc` / `.hap` / `.har` 文件，反编译并构建 jadx 风格的
//! 项目树（包 → 类 → 方法），按节点懒加载内容切片。
//!
//! 打开流程：
//! 1. `.abc` 直接使用；压缩包（`.hap` / `.har` / `.app` / `.zip`）解包提取
//!    全部 `.abc` 条目到临时目录；
//! 2. 逐个调用官方 `ark_disasm`（见 [`crate::runner`]）生成 `.pa` 文本；
//! 3. 解析 `.pa`（见 [`crate::pa`]）并按 record 展示名构建包层级树。

use std::collections::HashMap;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::pa::{PaFile, PaRecord};
use crate::runner;

/// 树节点的类型，前端据此选择图标与交互行为。
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum NodeKind {
    /// 项目根节点（对应打开的文件）。
    Root,
    /// 一个 `.abc` 字节码单元。
    Abc,
    /// 包（由类名的 `.` 分段推导）。
    Package,
    /// 类（pandasm record）。
    Class,
    /// 方法。
    Method,
    /// 资源目录（压缩包内非 `.abc` 文件的容器节点）。
    ResourceDir,
    /// 资源文件。
    Resource,
}

/// 项目树节点，序列化后直接作为前端渲染模型。
#[derive(Debug, Clone, Serialize)]
pub struct TreeNode {
    /// 全项目唯一的节点 ID，用于向后端请求内容。
    pub id: u32,
    /// 展示名（包名最后一段 / 类短名 / 方法名等）。
    pub name: String,
    /// 节点类型。
    pub kind: NodeKind,
    /// 附加说明（如类数量、字节码版本），为空时不序列化。
    #[serde(skip_serializing_if = "String::is_empty")]
    pub detail: String,
    /// 子节点；方法与资源文件为叶子节点。
    pub children: Vec<TreeNode>,
}

/// 节点 ID 到数据位置的映射载荷。
///
/// 树中每个可请求内容的节点都会在 [`Project::nodes`] 注册一条，
/// [`Project::content`] 据此定位到具体数据切片。
enum NodePayload {
    /// `.abc` 单元概览。
    Unit {
        /// 在 [`Project::units`] 中的下标。
        unit: usize,
    },
    /// 类内容（整条 record 的 pandasm 文本）。
    Class {
        /// 所属单元下标。
        unit: usize,
        /// record 在 [`PaFile::records`] 中的下标。
        record: usize,
    },
    /// 单个方法内容。
    Method {
        /// 所属单元下标。
        unit: usize,
        /// record 下标。
        record: usize,
        /// 方法在 [`PaRecord::methods`] 中的下标。
        method: usize,
    },
    /// 压缩包内资源条目。
    Resource {
        /// 在 [`Project::archive_entries`] 中的下标。
        entry: usize,
    },
}

/// 一个已解析的 `.abc` 字节码单元。
struct AbcUnit {
    /// 展示名，如压缩包内的原始路径 `ets/modules.abc`。
    name: String,
    /// 反编译并解析后的 `.pa` 结构。
    pa: PaFile,
}

/// 一个已打开的项目（对应一个用户打开的文件）。
pub struct Project {
    /// 项目名（打开文件的文件名）。
    pub name: String,
    /// 文件扩展名小写形式（`abc` / `hap` / `har` ...）。
    pub kind: String,
    /// 打开文件的绝对路径（保留供后续「资源文件预览」等功能使用）。
    #[allow(dead_code)]
    pub source_path: PathBuf,
    /// 包含的全部 `.abc` 单元。
    units: Vec<AbcUnit>,
    /// 压缩包内非 `.abc` 条目的路径列表。
    archive_entries: Vec<String>,
    /// 节点 ID -> 数据载荷映射。
    nodes: HashMap<u32, NodePayload>,
    /// 项目树根节点。
    tree: TreeNode,
    /// 节点 ID 分配计数器。
    next_id: u32,
}

impl Project {
    /// 分配下一个全局唯一节点 ID。
    fn alloc_id(&mut self) -> u32 {
        self.next_id += 1;
        self.next_id
    }

    /// 打开一个 `.abc` / `.hap` / `.har` 文件并构建项目。
    ///
    /// 每个包含的 `.abc` 都会用官方 `ark_disasm` 反编译，生成的标准 `.pa`
    /// 文本被解析为项目树。
    ///
    /// # 参数
    /// - `path`：要打开的文件路径；
    /// - `tool_path`：用户配置的 `ark_disasm` 路径，`None` 时自动探测。
    ///
    /// # Errors
    /// 文件读取/解压失败、`ark_disasm` 不可用或执行失败、包内无 `.abc`
    /// 时返回中文错误信息（直接展示给用户）。
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

        // 待反编译的 (显示名, abc 文件路径) 列表
        let mut abc_files: Vec<(String, PathBuf)> = vec![];
        // 压缩包内非 `.abc` 条目
        let mut archive_entries: Vec<String> = vec![];
        // 需要在流程结束时清理的临时目录
        let mut temp_dirs: Vec<PathBuf> = vec![];

        // 第一阶段：收集 `.abc` 文件（`.abc` 直接使用；压缩包解包提取）
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
                            // 提取到临时目录，供 ark_disasm 读取
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

        // 第二阶段：反编译并解析；无论成败都先清理临时目录
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

    /// 构建项目树：根节点 -> `.abc` 单元 -> 包层级 -> 类 -> 方法，
    /// 压缩包项目额外挂一个 `resources` 资源目录。
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

            // 按类名（record 展示名）构建包层级
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

    /// 获取项目树的只读引用（返回给前端渲染）。
    pub fn tree(&self) -> &TreeNode {
        &self.tree
    }

    /// 获取指定节点的内容切片（标题、语言、正文）。
    ///
    /// 类节点返回完整 record 文本；方法节点返回单方法文本；
    /// 单元节点返回概览信息。未知节点返回错误。
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

/// 在系统临时目录下创建本次打开操作的唯一工作目录。
fn temp_root() -> Result<PathBuf, String> {
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_nanos();
    let dir = std::env::temp_dir().join(format!("abcde-{ts}"));
    fs::create_dir_all(&dir).map_err(|e| format!("创建临时目录失败: {e}"))?;
    Ok(dir)
}

/// 将压缩包条目路径转换为安全的单层文件系统名（防目录穿越）。
///
/// 例如 `ets/pages/index.abc` 转换为 `ets__pages__index.abc`；
/// 过滤空段、`.` 与 `..`。
fn sanitize_component(name: &str) -> String {
    name.split('/')
        .filter(|s| !s.is_empty() && *s != ".." && *s != ".")
        .collect::<Vec<_>>()
        .join("__")
}

/// 包层级的中间结构，用于把类名按 `.` 分段归组到包节点。
#[derive(Default)]
struct PackageNode {
    /// 子包名 -> 子包节点（BTreeMap 保证输出按名称有序）。
    children: std::collections::BTreeMap<String, PackageNode>,
    /// 直接挂在该包下的 record 下标列表。
    records: Vec<usize>,
}

/// 将一个 record 按展示名的 `.` 分段插入包层级。
///
/// 单段名、空名、以 `<` 开头（如 `<global>`）或含空格的名称
/// 直接挂在根上，不参与包分组。
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

/// 递归把 [`PackageNode`] 层级展开为树节点列表。
///
/// 同时为每个类/方法节点注册 [`NodePayload`]，并分配节点 ID。
/// `prefix` 为当前递归的完整包名（用于子包拼接，节点展示只用最后一段）。
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
        // 先克隆所需数据，避免同时持有 project 的可变/不可变借用
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

/// 为压缩包内非 `.abc` 条目构建扁平的资源节点列表（按文件名排序）。
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

/// 节点内容切片，前端代码视图的渲染数据。
#[derive(Debug, Clone, Serialize)]
pub struct NodeContent {
    /// 内容标题（完整类名 / `类.方法` / 单元名）。
    pub title: String,
    /// 内容语言标记（`asm` 或 `text`），前端据此选择高亮方式。
    pub language: String,
    /// 正文文本。
    pub body: String,
}
