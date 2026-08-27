//! 项目模型：打开 `.abc` / `.hap` / `.har` 文件，反编译并构建 jadx 风格的
//! 项目树（包 → 类 → 方法），按节点懒加载内容切片。
//!
//! 打开流程：
//! 1. `.abc` 直接使用；压缩包（`.hap` / `.har` / `.app` / `.zip`）解包提取
//!    全部 `.abc` 条目到临时目录；
//! 2. 逐个调用官方 `ark_disasm`（见 [`crate::runner`]）生成 `.pa` 文本；
//! 3. 解析 `.pa`（见 [`crate::pa`]）并按 record 展示名构建包层级树。
//!
//! 支持把项目包含的全部原始 `.abc` 字节码批量导出到指定目录
//! （见 [`Project::export_abc_all`]）。

use std::cell::RefCell;
use std::collections::HashMap;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::decompiler::{self, LiteralNames};
use crate::pa::{PaFile, PaMethod, PaRecord};
use crate::runner;
use crate::search::{self, SearchOptions, SearchResponse};

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
pub(crate) struct AbcUnit {
    /// 展示名，如压缩包内的原始路径 `ets/modules.abc`。
    pub(crate) name: String,
    /// 反编译并解析后的 `.pa` 结构。
    pub(crate) pa: PaFile,
    /// 字面量池名称表（调用目标解析；旧版工具可能为空）。
    pub(crate) names: LiteralNames,
}

/// 一个已打开的项目（对应一个用户打开的文件）。
pub struct Project {
    /// 项目名（打开文件的文件名）。
    pub name: String,
    /// 文件扩展名小写形式（`abc` / `hap` / `har` ...）。
    pub kind: String,
    /// 打开文件的绝对路径（保存 `.hark` 工作区时引用；资源预览等也会用到）。
    pub source_path: PathBuf,
    /// 包含的全部 `.abc` 单元。
    units: Vec<AbcUnit>,
    /// 压缩包内非 `.abc` 条目的路径列表。
    archive_entries: Vec<String>,
    /// 节点 ID -> 数据载荷映射。
    nodes: HashMap<u32, NodePayload>,
    /// (单元下标, record 下标) -> 类节点 ID（搜索结果反向定位）。
    class_nodes: HashMap<(usize, usize), u32>,
    /// 资源条目下标 -> 资源节点 ID（资源名搜索反向定位）。
    resource_nodes: HashMap<usize, u32>,
    /// 项目树根节点。
    tree: TreeNode,
    /// 节点 ID 分配计数器。
    next_id: u32,
    /// ArkTS 还原结果的惰性缓存（节点 ID -> 内容）。
    ets_cache: RefCell<HashMap<u32, NodeContent>>,
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
    /// - `tool_path`：用户配置的 `ark_disasm` 路径，`None` 时自动探测；
    /// - `bundled`：随应用分发的内置 `ark_disasm` 完整路径（资源目录）。
    ///
    /// # Errors
    /// 文件读取/解压失败、`ark_disasm` 不可用或执行失败、包内无 `.abc`
    /// 时返回中文错误信息（直接展示给用户）。
    pub fn open(
        path: &Path,
        tool_path: Option<&str>,
        bundled: Option<&Path>,
        is_cancelled: &dyn Fn() -> bool,
    ) -> Result<Project, String> {
        let tool = runner::locate(tool_path, bundled)?;
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
                    let mut archive = open_zip(path)?;
                    let work_dir = temp_root()?;
                    temp_dirs.push(work_dir.clone());
                    for i in 0..archive.len() {
                        if is_cancelled() {
                            return Err("cancelled".into());
                        }
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
                if is_cancelled() {
                    return Err("cancelled".into());
                }
                let (text, names) = runner::disassemble_with_names(&tool, abc_path)?;
                units.push(AbcUnit {
                    name: name.clone(),
                    pa: PaFile::parse(&text),
                    names,
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
            class_nodes: HashMap::new(),
            resource_nodes: HashMap::new(),
            tree: TreeNode {
                id: 0,
                name: String::new(),
                kind: NodeKind::Root,
                detail: String::new(),
                children: vec![],
            },
            next_id: 0,
            ets_cache: RefCell::new(HashMap::new()),
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
    /// `view` 为 `"abc"` 时返回 pandasm 反汇编文本（原行为）；
    /// 为 `"ets"` 时返回 ArkTS 还原结果（惰性生成并缓存）。
    /// 未知节点返回错误。
    pub fn content(&self, node_id: u32, view: &str) -> Result<NodeContent, String> {
        if view == "ets" {
            if let Some(cached) = self.ets_cache.borrow().get(&node_id) {
                return Ok(cached.clone());
            }
            let content = self.generate_ets(node_id)?;
            self.ets_cache.borrow_mut().insert(node_id, content.clone());
            return Ok(content);
        }
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
                Ok(NodeContent {
                    title: format!("{}.{}", rec.display_name, m.name),
                    language: "asm".into(),
                    body: render_method_asm(m),
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

    /// 定位方法节点在其所属类内容中的行位置（用于点击方法跳转到类内声明处）。
    ///
    /// 返回所属类节点 ID 与该方法在 abc / ets 视图中的 1-based 行号；
    /// 行号为 0 表示未找到对应声明行。非方法节点返回错误。
    pub fn method_location(&self, node_id: u32) -> Result<MethodLocation, String> {
        let payload = self.nodes.get(&node_id).ok_or(format!("未知节点 #{node_id}"))?;
        let NodePayload::Method { unit, record, method } = payload else {
            return Err("该节点不是方法节点".into());
        };

        let u = &self.units[*unit];
        let rec = u.pa.records.get(*record).ok_or("record missing")?;
        let m = rec.methods.get(*method).ok_or("method missing")?;

        // 所属类节点 ID
        let class_node_id = *self
            .class_nodes
            .get(&(*unit, *record))
            .ok_or("class node not found")?;

        // abc 视图：在类反汇编文本中查找 `.function <signature> {`
        let abc_body = u.pa.render_record(*record).ok_or("record missing")?;
        let abc_target = format!(".function {} {{", m.signature);
        let abc_line = abc_body
            .lines()
            .position(|l| l.contains(&abc_target))
            .map(|i| i as u32 + 1)
            .unwrap_or(0);

        // ets 视图：在类 ArkTS 还原中查找方法声明行
        let ets_content = self.content(class_node_id, "ets")?;
        let s = decompiler::sig::parse(&m.signature);
        let method_name = if s.is_ctor() {
            "constructor".to_string()
        } else {
            s.name.clone()
        };
        let needle = format!("{}(", method_name);
        let ets_line = ets_content
            .body
            .lines()
            .position(|line| {
                let trimmed = line.trim();
                if !trimmed.ends_with(" {") {
                    return false;
                }
                if let Some(pos) = trimmed.find(&needle) {
                    if pos == 0 {
                        return true;
                    }
                    let prev = trimmed.as_bytes()[pos - 1];
                    !prev.is_ascii_alphanumeric() && prev != b'_' && prev != b'$'
                } else {
                    false
                }
            })
            .map(|i| i as u32 + 1)
            .unwrap_or(0);

        Ok(MethodLocation {
            class_node_id,
            abc_line,
            ets_line,
        })
    }

    /// 生成节点的 ArkTS 还原内容（不查缓存）。
    fn generate_ets(&self, node_id: u32) -> Result<NodeContent, String> {
        match self.nodes.get(&node_id) {
            Some(NodePayload::Unit { unit }) => {
                let u = &self.units[*unit];
                Ok(NodeContent {
                    title: u.name.clone(),
                    language: "ts".into(),
                    body: format!(
                        "// {}\n// 共 {} 个类型；展开左侧节点查看单个类的还原结果。\n",
                        u.name,
                        u.pa.records.len(),
                    ),
                })
            }
            Some(NodePayload::Class { unit, record }) => {
                let u = &self.units[*unit];
                let rec = u.pa.records.get(*record).ok_or("record missing")?;
                let body = decompiler::record_to_arkts(rec, &u.names);
                Ok(NodeContent {
                    title: rec.display_name.clone(),
                    language: "ts".into(),
                    body,
                })
            }
            Some(NodePayload::Method { unit, record, method }) => {
                let u = &self.units[*unit];
                let rec = u.pa.records.get(*record).ok_or("record missing")?;
                let m = rec.methods.get(*method).ok_or("method missing")?;
                let body = decompiler::method_to_arkts(&rec.display_name, m, &u.names);
                Ok(NodeContent {
                    title: format!("{}.{}", rec.display_name, m.name),
                    language: "ts".into(),
                    body,
                })
            }
            // 单元概览与资源节点没有汇编语义，直接沿用 abc 视图
            _ => self.content(node_id, "abc"),
        }
    }

    /// 导出指定节点的 `.ets` 内容到目标路径。
    pub fn export_ets(&self, node_id: u32, target: &Path) -> Result<(), String> {
        let content = self.content(node_id, "ets")?;
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {e}"))?;
        }
        fs::write(target, content.body)
            .map_err(|e| format!("写入 {target:?} 失败: {e}"))
    }

    /// 导出指定节点的反汇编文本（abc 视图）到目标路径（`.pa` 格式）。
    ///
    /// # Errors
    /// 节点无效或写入失败时返回中文错误信息。
    pub fn export_pa(&self, node_id: u32, target: &Path) -> Result<(), String> {
        let content = self.content(node_id, "abc")?;
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {e}"))?;
        }
        fs::write(target, content.body)
            .map_err(|e| format!("写入 {target:?} 失败: {e}"))
    }

    /// 把项目包含的全部原始 `.abc` 字节码批量导出到目标目录。
    ///
    /// 实际写入位置为 `<dir>/<项目名去扩展名>/`：
    /// - `.abc` 项目：直接把源文件复制为 `<dir>/<stem>/<文件名>`；
    /// - 压缩包项目：从 [`Project::source_path`] 重新读取压缩包，提取全部
    ///   `.abc` 条目并按包内相对路径保存，不依赖打开时的临时文件；
    /// - 同名已存在的文件会被覆盖。
    ///
    /// 返回成功写入的文件相对路径列表（相对导出子目录，使用包内原始名）。
    ///
    /// # Errors
    /// 目标目录创建失败、源文件读取失败或写盘失败时返回中文错误信息。
    pub fn export_abc_all(&self, dir: &Path) -> Result<Vec<String>, String> {
        // 导出子目录名取自项目名的去扩展名形式（如 `demo.hap` → `demo`）
        let stem = Path::new(&self.name)
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| self.name.clone());
        let root = dir.join(sanitize_component(&stem));
        fs::create_dir_all(&root).map_err(|e| format!("创建目录失败: {e}"))?;

        match self.kind.as_str() {
            "abc" => {
                let target = root.join(&self.name);
                fs::copy(&self.source_path, &target).map_err(|e| {
                    format!("复制 {}: {e}", self.source_path.display())
                })?;
                Ok(vec![self.name.clone()])
            }
            "hap" | "har" | "app" | "zip" => {
                let mut archive = open_zip(&self.source_path)?;
                let mut written = vec![];
                for i in 0..archive.len() {
                    let mut entry = archive
                        .by_index(i)
                        .map_err(|e| format!("压缩包条目 #{i}: {e}"))?;
                    let name = entry.name().to_string();
                    if name.ends_with('/') || entry.is_dir() {
                        continue;
                    }
                    if !name.to_ascii_lowercase().ends_with(".abc") {
                        continue;
                    }
                    let Some(rel) = safe_relative_path(&name) else {
                        continue;
                    };
                    let target = root.join(rel);
                    if let Some(parent) = target.parent() {
                        fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {e}"))?;
                    }
                    let mut bytes = Vec::new();
                    entry.read_to_end(&mut bytes).map_err(|e| format!("读取 `{name}`: {e}"))?;
                    fs::write(&target, &bytes).map_err(|e| format!("写入 {target:?} 失败: {e}"))?;
                    written.push(name);
                }
                if written.is_empty() {
                    return Err("该文件中没有找到 .abc 字节码".into());
                }
                Ok(written)
            }
            other => Err(format!("不支持的文件类型: .{other}")),
        }
    }

    /// 把项目包含的全部反汇编文本按项目树结构批量导出为 `.pa` 文件。
    ///
    /// 导出布局镜像前端项目树：`<dir>/<项目名>/[<单元名>/]<包>/<子包>/<类>.pa`。
    /// - 单单元项目省略单元目录，包层级直接放在项目根下；
    /// - 多单元项目为每个 `.abc` 建一个以短名（去 `.abc`）命名的子目录，
    ///   同名单元追加 `-2`/`-3` 去重；
    /// - 类文件按其展示名的 `.` 分段落入对应包层级，`<global>` 等无包名类
    ///   直接放在单元目录下；同名类路径追加数字后缀去重；
    /// - 每个文件内容为该类的完整 pandasm 反汇编（与 `.abc` 视图一致）。
    ///
    /// 返回成功写入的文件相对路径列表（相对导出子目录，使用正斜杠）。
    ///
    /// # Errors
    /// 目标目录创建失败或写盘失败时返回中文错误信息。
    pub fn export_pa_all(&self, dir: &Path) -> Result<Vec<String>, String> {
        let stem = Path::new(&self.name)
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| self.name.clone());
        let root = dir.join(sanitize_component(&stem));
        fs::create_dir_all(&root).map_err(|e| format!("创建目录失败: {e}"))?;

        let single_unit = self.units.len() == 1;
        let mut used_unit_dirs: std::collections::HashSet<String> = std::collections::HashSet::new();
        let mut written: Vec<String> = Vec::new();

        for unit in &self.units {
            // 单单元项目直接放在项目根下；多单元项目按单元短名建子目录
            let unit_dir = if single_unit {
                root.clone()
            } else {
                let short = unit.name.rsplit('/').next().unwrap_or(&unit.name);
                let base = sanitize_filename(short.trim_end_matches(".abc"));
                let mut name = base.clone();
                let mut n = 2;
                while !used_unit_dirs.insert(name.clone()) {
                    name = format!("{base}-{n}");
                    n += 1;
                }
                root.join(&name)
            };

            // 同一单元内同类名去重
            let mut used: std::collections::HashSet<PathBuf> = std::collections::HashSet::new();
            for ri in 0..unit.pa.records.len() {
                let display = &unit.pa.records[ri].display_name;
                let (parents, leaf) = split_record_name(display);
                let at_root =
                    parents.is_empty() || leaf.starts_with('<') || display.contains(' ');
                let leaf = sanitize_filename(&leaf);
                let mut folder = unit_dir.clone();
                if !at_root {
                    for seg in &parents {
                        folder = folder.join(sanitize_filename(seg));
                    }
                }
                // 文件名去重：Foo.pa → Foo-2.pa → Foo-3.pa …
                let mut n = 1;
                let file_name = loop {
                    let name = if n == 1 {
                        format!("{leaf}.pa")
                    } else {
                        format!("{leaf}-{n}.pa")
                    };
                    if used.insert(folder.join(&name)) {
                        break name;
                    }
                    n += 1;
                };
                let target = folder.join(&file_name);
                fs::create_dir_all(&folder).map_err(|e| format!("创建目录失败: {e}"))?;
                let body = unit.pa.render_record(ri).unwrap_or_default();
                fs::write(&target, body)
                    .map_err(|e| format!("写入 {target:?} 失败: {e}"))?;
                let rel = target.strip_prefix(&root).unwrap_or(&target);
                written.push(rel.to_string_lossy().replace('\\', "/"));
            }
        }

        if written.is_empty() {
            return Err("该项目没有可导出的反汇编内容".into());
        }
        Ok(written)
    }

    /// 全局搜索：对内存中已解析的 `.pa` 数据按多类别检索。
    ///
    /// `is_cancelled` 由命令层周期性检查；取消时结果为空且带
    /// `cancelled: true` 标志，前端会丢弃该次结果。参数错误返回中文错误信息。
    pub fn search(
        &self,
        options: &SearchOptions,
        is_cancelled: &dyn Fn() -> bool,
    ) -> Result<SearchResponse, String> {
        let ctx = search::SearchContext {
            units: &self.units,
            class_nodes: &self.class_nodes,
            resource_entries: &self.archive_entries,
            resource_nodes: &self.resource_nodes,
        };
        search::run(&ctx, options, is_cancelled)
    }
}

/// 渲染单方法的 pandasm 文本（`.function` 头 + 重排缩进的指令体）。
fn render_method_asm(m: &PaMethod) -> String {
    let mut body = String::new();
    // 真实格式中 `{` 位于 .function 行尾
    body.push_str(&format!(".function {} {{\n", m.signature));
    for line in &m.body {
        let trimmed = line.trim_start();
        if trimmed.is_empty() {
            body.push('\n');
        } else {
            body.push_str("    ");
            body.push_str(trimmed);
            body.push('\n');
        }
    }
    body.push_str("}\n");
    body
}

/// 在系统临时目录下创建本次打开操作的唯一工作目录。
fn temp_root() -> Result<PathBuf, String> {
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_nanos();
    let dir = std::env::temp_dir().join(format!("hark-{ts}"));
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

/// 打开 zip 压缩包（整体读入内存后解析），打开失败返回中文错误信息。
fn open_zip(path: &Path) -> Result<zip::ZipArchive<std::io::Cursor<Vec<u8>>>, String> {
    let data = fs::read(path).map_err(|e| format!("读取失败: {e}"))?;
    let cursor = std::io::Cursor::new(data);
    zip::ZipArchive::new(cursor).map_err(|e| format!("无效压缩包: {e}"))
}

/// 把压缩包条目名转换为导出根目录下的安全相对路径（保留包内层级）。
///
/// 按 `/` 与 `\` 分段，过滤空段、`.` 与 `..`；段内的 `:` 替换为 `_`，
/// 防止 Windows 盘符形式的段在写盘时逃逸到其他位置。全部段被过滤时
/// （如条目名只有目录分隔符）返回 `None`。
///
/// - `ets/modules.abc`     -> `ets/modules.abc`
/// - `..\..\evil.abc`      -> `evil.abc`
/// - `C:steal.abc`         -> `C_steal.abc`
fn safe_relative_path(name: &str) -> Option<PathBuf> {
    let mut rel = PathBuf::new();
    for seg in name.split(['/', '\\']) {
        match seg {
            "" | "." | ".." => {}
            s => rel.push(s.replace(':', "_")),
        }
    }
    if rel.as_os_str().is_empty() {
        None
    } else {
        Some(rel)
    }
}

/// 把文件名中各平台禁止的字符替换为 `_`（`\ / : * ? " < > |`）。
///
/// 用于导出时把类名 / 包名段转换为安全的文件系统名；`&` 等合法字符保留。
fn sanitize_filename(name: &str) -> String {
    name.chars()
        .map(|c| match c {
            '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            c => c,
        })
        .collect()
}

/// 包层级的中间结构，用于把类名按 `.` 分段归组到包节点。
#[derive(Default)]
struct PackageNode {
    /// 子包名 -> 子包节点（BTreeMap 保证输出按名称有序）。
    children: std::collections::BTreeMap<String, PackageNode>,
    /// 直接挂在该包下的 record 下标列表。
    records: Vec<usize>,
}

/// 将 record 展示名拆分为（包路径段, 类短名）。
///
/// 名称末尾可能带版本号后缀（如 `&cmcc.ssosdk.d&1.0.9` 中的 `&1.0.9`），
/// 以最后一个 `&` 为界：后缀整体并入类短名，不参与 `.` 分段。
///
/// - `&cmcc.ssosdk.d&1.0.9` -> (`[&cmcc, ssosdk]`, `d&1.0.9`)
/// - `com.example.Foo`      -> (`[com, example]`, `Foo`)
/// - `Foo` / `<global>`     -> (`[]`, 原名)
fn split_record_name(display_name: &str) -> (Vec<&str>, String) {
    let (body, version) = match display_name.rfind('&') {
        Some(pos) => (&display_name[..pos], &display_name[pos..]),
        None => (display_name, ""),
    };
    let mut segments: Vec<&str> = body.split('.').filter(|s| !s.is_empty()).collect();
    match segments.pop() {
        Some(last) if !segments.is_empty() => (segments, format!("{last}{version}")),
        // 单段名（可能整体带版本后缀）直接作为根级类
        _ => (Vec::new(), display_name.to_string()),
    }
}

/// 将一个 record 按展示名插入包层级（版本号后缀不参与分段）。
///
/// 单段名、空名、以 `<` 开头（如 `<global>`）或含空格的名称
/// 直接挂在根上，不参与包分组。
fn insert_record(root: &mut PackageNode, display_name: &str, record_idx: usize) {
    let (parents, leaf) = split_record_name(display_name);
    if parents.is_empty() || leaf.starts_with('<') || display_name.contains(' ') {
        root.records.push(record_idx);
        return;
    }
    let mut node = root;
    for seg in &parents {
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
            let (_, leaf) = split_record_name(&rec.display_name);
            let names = rec.methods.iter().map(|m| m.name.clone()).collect::<Vec<_>>();
            (leaf, names)
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
        project.class_nodes.insert((unit, *ri), id);
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
        project.resource_nodes.insert(i, id);
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

/// 方法在其所属类内容中的行定位信息（用于「点击方法跳转到类内声明处」）。
#[derive(Debug, Clone, Serialize)]
pub struct MethodLocation {
    /// 所属类节点的 ID。
    pub class_node_id: u32,
    /// abc 视图中方法声明所在行（1-based，0 表示未找到）。
    pub abc_line: u32,
    /// ets 视图中方法声明所在行（1-based，0 表示未找到）。
    pub ets_line: u32,
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write as _;

    /// 版本号后缀（最后一个 `&` 起）必须整体并入类短名，不参与 `.` 分段。
    #[test]
    fn splits_record_name_with_version_suffix() {
        let (parents, leaf) = split_record_name("&cmcc.ssosdk.d&1.0.9");
        assert_eq!(parents, vec!["&cmcc", "ssosdk"]);
        assert_eq!(leaf, "d&1.0.9");

        let (parents, leaf) = split_record_name("com.example.Foo");
        assert_eq!(parents, vec!["com", "example"]);
        assert_eq!(leaf, "Foo");

        // 单段名（即使带版本后缀）直接作为根级类
        let (parents, leaf) = split_record_name("&cmcc&1.0.9");
        assert!(parents.is_empty());
        assert_eq!(leaf, "&cmcc&1.0.9");

        let (parents, leaf) = split_record_name("Foo");
        assert!(parents.is_empty());
        assert_eq!(leaf, "Foo");
    }

    /// 安全相对路径：保留层级、过滤穿越与空段、替换盘符冒号。
    #[test]
    fn builds_safe_relative_paths() {
        assert_eq!(
            safe_relative_path("ets/modules.abc"),
            Some(PathBuf::from("ets/modules.abc"))
        );
        assert_eq!(
            safe_relative_path("../evil.abc"),
            Some(PathBuf::from("evil.abc"))
        );
        assert_eq!(
            safe_relative_path("..\\..\\x\\y.abc"),
            Some(PathBuf::from("x/y.abc"))
        );
        assert_eq!(
            safe_relative_path("/abs.abc"),
            Some(PathBuf::from("abs.abc"))
        );
        assert_eq!(
            safe_relative_path("C:steal.abc"),
            Some(PathBuf::from("C_steal.abc"))
        );
        assert_eq!(safe_relative_path("/"), None);
    }

    /// 构造一个仅填充导出逻辑所需字段的最小项目实例。
    fn bare_project(name: &str, kind: &str, source: PathBuf) -> Project {
        Project {
            name: name.to_string(),
            kind: kind.to_string(),
            source_path: source,
            units: vec![],
            archive_entries: vec![],
            nodes: HashMap::new(),
            class_nodes: HashMap::new(),
            resource_nodes: HashMap::new(),
            tree: TreeNode {
                id: 0,
                name: String::new(),
                kind: NodeKind::Root,
                detail: String::new(),
                children: vec![],
            },
            next_id: 0,
            ets_cache: RefCell::new(HashMap::new()),
        }
    }

    /// 压缩包项目只导出 `.abc` 条目且保持包内层级（资源被跳过）；
    /// `.abc` 直开项目把源文件复制为 `<目录>/<项目名去扩展名>/<文件名>`。
    #[test]
    fn exports_raw_abc_from_archive_and_copies_single_abc() {
        let tmp = std::env::temp_dir().join(format!("hark-export-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();

        // 构造最小压缩包：一个 .abc 条目 + 一个资源条目
        let hap_path = tmp.join("demo.hap");
        let file = fs::File::create(&hap_path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default();
        zip.start_file("ets/modules.abc", options).unwrap();
        zip.write_all(b"ABC-BYTES").unwrap();
        zip.start_file("assets/logo.png", options).unwrap();
        zip.write_all(b"png").unwrap();
        zip.finish().unwrap();

        let out_dir = tmp.join("out");
        let project = bare_project("demo.hap", "hap", hap_path.clone());
        let written = project.export_abc_all(&out_dir).unwrap();
        assert_eq!(written, vec!["ets/modules.abc"]);
        let target = out_dir.join("demo").join("ets").join("modules.abc");
        assert_eq!(fs::read(&target).unwrap(), b"ABC-BYTES");
        assert!(!out_dir.join("demo/assets").exists());

        // 直接打开的 .abc 项目：走复制分支
        let abc_path = tmp.join("single.abc");
        fs::write(&abc_path, b"SINGLE").unwrap();
        let project = bare_project("single.abc", "abc", abc_path);
        let written = project.export_abc_all(&out_dir).unwrap();
        assert_eq!(written, vec!["single.abc"]);
        assert_eq!(
            fs::read(out_dir.join("single").join("single.abc")).unwrap(),
            b"SINGLE"
        );

        let _ = fs::remove_dir_all(&tmp);
    }

    /// 整单元反汇编导出：单单元项目每个类按包层级写出一份 `.pa`。
    #[test]
    fn exports_full_pa_per_class_in_package_tree() {
        let pa = crate::pa::PaFile::parse(
            ".record Lcom/example/Foo; {\n.access_flags public\n}\n\
             .function any Lcom/example/Foo;.bar() {\nreturn\n}\n\
             .record Lcom/example/Bar; {\n}\n\
             .record LGlobal; {\n}\n",
        );
        let unit = AbcUnit {
            name: "ets/modules.abc".to_string(),
            pa,
            names: crate::decompiler::LiteralNames::default(),
        };
        let tmp = std::env::temp_dir().join(format!("hark-pa-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();

        let project = Project {
            name: "demo.hap".to_string(),
            kind: "hap".to_string(),
            source_path: tmp.join("demo.hap"),
            units: vec![unit],
            archive_entries: vec![],
            nodes: HashMap::new(),
            class_nodes: HashMap::new(),
            resource_nodes: HashMap::new(),
            tree: TreeNode {
                id: 0,
                name: String::new(),
                kind: NodeKind::Root,
                detail: String::new(),
                children: vec![],
            },
            next_id: 0,
            ets_cache: RefCell::new(HashMap::new()),
        };
        let out_dir = tmp.join("out");
        let mut written = project.export_pa_all(&out_dir).unwrap();
        written.sort();
        // 单单元省略单元目录；com/example 下两个类，无包名类放根下
        assert_eq!(
            written,
            vec!["Global.pa", "com/example/Bar.pa", "com/example/Foo.pa"]
        );
        let foo = fs::read_to_string(out_dir.join("demo").join("com").join("example").join("Foo.pa")).unwrap();
        assert!(foo.contains(".record Lcom/example/Foo; {"));
        assert!(foo.contains(".function any Lcom/example/Foo;.bar() {"));
        assert!(foo.contains("return"));

        let _ = fs::remove_dir_all(&tmp);
    }

    /// 多单元项目为每个 `.abc` 建子目录；显示名相同（原始名不同）的类在单元内去重。
    #[test]
    fn exports_pa_with_unit_dirs_and_dedup() {
        // Lcom.Foo; 与 Lcom/Foo; 的展示名均为 com.Foo，导出路径相同需去重
        let make_unit = |name: &str| AbcUnit {
            name: name.to_string(),
            pa: crate::pa::PaFile::parse(
                ".record Lcom.Foo; {\n}\n.record Lcom/Foo; {\n}\n",
            ),
            names: crate::decompiler::LiteralNames::default(),
        };
        let tmp = std::env::temp_dir().join(format!("hark-pa2-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();

        let project = Project {
            name: "app.hap".to_string(),
            kind: "hap".to_string(),
            source_path: tmp.join("app.hap"),
            units: vec![make_unit("ets/modules.abc"), make_unit("libs/modules.abc")],
            archive_entries: vec![],
            nodes: HashMap::new(),
            class_nodes: HashMap::new(),
            resource_nodes: HashMap::new(),
            tree: TreeNode {
                id: 0,
                name: String::new(),
                kind: NodeKind::Root,
                detail: String::new(),
                children: vec![],
            },
            next_id: 0,
            ets_cache: RefCell::new(HashMap::new()),
        };
        let out_dir = tmp.join("out");
        let mut written = project.export_pa_all(&out_dir).unwrap();
        written.sort();
        // 两个单元各建一个 modules 目录；单元内同路径类去重为 Foo.pa / Foo-2.pa
        assert_eq!(
            written,
            vec![
                "modules-2/com/Foo-2.pa",
                "modules-2/com/Foo.pa",
                "modules/com/Foo-2.pa",
                "modules/com/Foo.pa",
            ]
        );
        assert!(out_dir.join("app").join("modules").join("com").join("Foo.pa").exists());
        assert!(out_dir.join("app").join("modules").join("com").join("Foo-2.pa").exists());
        assert!(out_dir.join("app").join("modules-2").join("com").join("Foo.pa").exists());

        let _ = fs::remove_dir_all(&tmp);
    }
}
