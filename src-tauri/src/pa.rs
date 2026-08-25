//! 官方 `ark_disasm` 反编译文本（`.pa`）解析器。
//!
//! `ark_disasm` 的真实输出布局为两段式：
//!
//! 1. **RECORDS 段**：所有 `.record { 字段 }` 块，record 块内只包含
//!    `.access_flags` / `.source_file` / `.field`，**从不包含函数**；
//! 2. **METHODS 段**：所有 `.function` 块顶层罗列，函数通过限定名与所属
//!    record 关联：`.function <返回类型> <RecordName>.<methodName>(...) <元数据> { ... }`。
//!
//! 本模块将上述文本解析为 [`PaFile`]（record 列表），并把每个函数回填到
//! 其所属的 [`PaRecord`] 上，供上层构建项目树与代码视图。

use std::collections::HashMap;

/// 一个方法（函数）的解析结果。
///
/// 对应 `.pa` 文本中的一个顶层 `.function` 块。
#[derive(Debug, Clone)]
pub struct PaMethod {
    /// 完整的 `.function` 头部行（不含 `.function` 指令本身），
    /// 例如 `any Lstd/core/String;.toString(...) <static false>`。
    pub signature: String,
    /// 方法短名，用于树节点展示，例如 `toString`。
    pub name: String,
    /// 方法体原始行（指令 / 标签），保留原始缩进、仅去除行尾空白。
    pub body: Vec<String>,
}

/// 一个类（record）的解析结果。
///
/// 对应 `.pa` 文本中的一个 `.record` 声明；其方法在解析阶段由
/// [`PaFile::parse`] 根据函数签名回填到 [`PaRecord::methods`]。
#[derive(Debug, Clone)]
pub struct PaRecord {
    /// record 原始名称（TypeDescriptor 形式），例如 `Lstd/core/String;`。
    pub raw_name: String,
    /// 展示名称：去除 `L` 前缀 / `;` 后缀，`/` 替换为 `.`，例如 `std.core.String`。
    pub display_name: String,
    /// 是否为外部（foreign）声明。外部 record 没有函数体，仅一行声明。
    pub is_external: bool,
    /// 来源文件名（`.source_file` 指令），例如 `std.core.String`。
    pub source_file: Option<String>,
    /// 访问标志（`.access_flags` 指令），例如 `public`。
    pub access_flags: Option<String>,
    /// 字段行列表（`.field` 指令原样内容）。
    pub fields: Vec<String>,
    /// 归属于该 record 的方法列表。
    pub methods: Vec<PaMethod>,
}

impl PaRecord {
    /// 根据原始名称创建空 record，展示名称自动经过 [`prettify_name`] 转换。
    fn new(raw_name: &str) -> Self {
        let display_name = prettify_name(raw_name);
        PaRecord {
            raw_name: raw_name.to_string(),
            display_name,
            is_external: false,
            source_file: None,
            access_flags: None,
            fields: vec![],
            methods: vec![],
        }
    }
}

/// 将 record 的 TypeDescriptor 原始名称转换为展示名称。
///
/// 例如 `Lfoo/bar/Baz;` 转换为 `foo.bar.Baz`；不符合描述符格式的名称原样返回。
pub fn prettify_name(raw: &str) -> String {
    let name = raw.trim();
    let name = name.strip_prefix('L').unwrap_or(name);
    let name = name.strip_suffix(';').unwrap_or(name);
    name.replace('/', ".")
}

/// 拆分 `.function` 签名。
///
/// 输入为 `.function` 后的剩余部分，形如
/// `<返回类型> <限定名>(<参数>) <元数据>`，其中限定名为
/// `<RecordName>.<methodName>`。返回 `(所属 record 原始名, 方法短名)`；
/// 无归属的全局函数（如 `funcmain`）返回空 record 名。
fn split_signature(signature: &str) -> (String, String) {
    let paren = signature.find('(').unwrap_or(signature.len());
    let head = &signature[..paren];
    let qualified = head.rsplit(' ').next().unwrap_or(head);
    match qualified.rfind('.') {
        Some(pos) => (qualified[..pos].to_string(), qualified[pos + 1..].to_string()),
        None => (String::new(), qualified.to_string()),
    }
}

/// 一个完整 `.pa` 文件的解析结果。
#[derive(Debug, Clone, Default)]
pub struct PaFile {
    /// 文件中出现的全部 record（定义的、外部声明的，以及为无归属函数
    /// 合成的 `<global>` record），按出现顺序排列。
    pub records: Vec<PaRecord>,
}

impl PaFile {
    /// 解析 `ark_disasm` 输出的 `.pa` 文本。
    ///
    /// 解析规则：
    /// - `.record <名> {` 开启 record（行尾无 `{` 视为外部声明）；
    /// - 顶层 `}` 关闭当前方法体或当前 record；
    /// - `.function` 块一律为顶层块，按签名中的限定名回填到所属 record；
    ///   若所属 record 未在 RECORDS 段出现（如系统类型）或为全局函数，
    ///   则合成一个新 record（全局函数归入 `<global>`）；
    /// - 方法体内含 `}` 的字符串字面量不会提前终止解析（整行匹配 `}` 才生效）；
    /// - 空行与 `#` 注释行被忽略。
    pub fn parse(text: &str) -> PaFile {
        let mut records: Vec<PaRecord> = Vec::new();
        // record 原始名 -> 在 `records` 中的下标
        let mut index: HashMap<String, usize> = HashMap::new();
        // 当前正在收集字段/指令的 record 下标
        let mut cur_record: Option<usize> = None;
        // 当前打开的方法体：(record 下标, 方法下标)
        let mut open_method: Option<(usize, usize)> = None;

        for line in text.lines() {
            let trimmed = line.trim();

            if trimmed.is_empty() || trimmed.starts_with('#') {
                continue;
            }

            if let Some(rest) = trimmed.strip_prefix(".record") {
                let rest = rest.trim();
                let name = rest.split_whitespace().next().unwrap_or("").to_string();
                let is_external = !rest.ends_with('{');
                cur_record = Some(match index.get(&name) {
                    Some(&idx) => idx,
                    None => {
                        let mut rec = PaRecord::new(&name);
                        rec.is_external = is_external;
                        records.push(rec);
                        index.insert(name, records.len() - 1);
                        records.len() - 1
                    }
                });
                continue;
            }

            if trimmed == "}" {
                if open_method.is_some() {
                    open_method = None;
                } else {
                    cur_record = None;
                }
                continue;
            }

            if let Some(rest) = trimmed.strip_prefix(".function") {
                let signature = rest.trim().to_string();
                let (owner_raw, method_name) = split_signature(&signature);
                let record_idx = match index.get(&owner_raw) {
                    Some(&idx) => idx,
                    None => {
                        // 所属 record 未在 RECORDS 段出现（如系统类型），
                        // 或为无归属全局函数 -> 合成一个 record
                        let raw = if owner_raw.is_empty() { "<global>" } else { owner_raw.as_str() };
                        records.push(PaRecord::new(raw));
                        index.insert(raw.to_string(), records.len() - 1);
                        records.len() - 1
                    }
                };
                records[record_idx].methods.push(PaMethod {
                    signature,
                    name: method_name,
                    body: vec![],
                });
                open_method = Some((record_idx, records[record_idx].methods.len() - 1));
                continue;
            }

            if let Some((ri, mi)) = open_method {
                records[ri].methods[mi].body.push(line.trim_end().to_string());
                continue;
            }

            if let Some(rec) = cur_record.map(|ri| &mut records[ri]) {
                if let Some(rest) = trimmed.strip_prefix(".source_file") {
                    rec.source_file = Some(rest.trim().trim_matches('"').to_string());
                } else if let Some(rest) = trimmed.strip_prefix(".access_flags") {
                    rec.access_flags = Some(rest.trim().to_string());
                } else if trimmed.starts_with(".field") {
                    rec.fields.push(trimmed.to_string());
                }
            }
        }

        PaFile { records }
    }

    /// 将指定下标的 record 还原为 pandasm 风格文本，用于类内容视图。
    ///
    /// 返回 `None` 表示下标越界。外部 record 只渲染一行声明。
    pub fn render_record(&self, idx: usize) -> Option<String> {
        let rec = self.records.get(idx)?;
        let mut out = String::new();
        if rec.is_external {
            out.push_str(&format!(".record {} <external>\n", rec.raw_name));
            return Some(out);
        }
        out.push_str(&format!(".record {} {{\n", rec.raw_name));
        if let Some(f) = &rec.access_flags {
            out.push_str(&format!("    .access_flags {f}\n"));
        }
        if let Some(sf) = &rec.source_file {
            out.push_str(&format!("    .source_file \"{sf}\"\n"));
        }
        for f in &rec.fields {
            out.push_str(&format!("    {f}\n"));
        }
        for m in &rec.methods {
            out.push('\n');
            // 真实格式中 `{` 位于 .function 行尾
            out.push_str(&format!("    .function {} {{\n", m.signature));
            for line in &m.body {
                out.push_str(line);
                out.push('\n');
            }
            out.push_str("    }\n");
        }
        out.push_str("}\n");
        Some(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 覆盖真实 ark_disasm 输出关键特征的样例：
    /// record 与函数分离、外部 record、含 `}` 的字符串字面量、全局函数。
    const SAMPLE: &str = r#"
# Some header comment
.record Lstd/core/String; {
	.access_flags public
	.source_file std.core.String
	.field public length
}

.record Lstd/core/Foreign; <external>

.function any Lstd/core/String;.toString(...) <static false> {
	mov v0, v1
	lda.str "brace } inside"
	L0001: ldai 0x2a
	return
}

.function void Lcom/example/Foo;.bar(i32) <static true> {
	ldai 0x1
	return
}

.function void funcmain() <static true> {
	return
}
"#;

    /// 验证 record/字段/方法解析及方法到 record 的归属回填。
    #[test]
    fn parses_records_methods_and_bodies() {
        let pa = PaFile::parse(SAMPLE);
        // String, Foreign, Foo, <global>
        assert_eq!(pa.records.len(), 4, "records: {:?}", pa.records.iter().map(|r| &r.raw_name).collect::<Vec<_>>());

        let s = &pa.records[0];
        assert_eq!(s.raw_name, "Lstd/core/String;");
        assert_eq!(s.display_name, "std.core.String");
        assert_eq!(s.source_file.as_deref(), Some("std.core.String"));
        assert_eq!(s.access_flags.as_deref(), Some("public"));
        assert_eq!(s.fields.len(), 1);
        assert_eq!(s.methods.len(), 1);
        assert_eq!(s.methods[0].name, "toString");
        // 含 '}' 的字符串字面量不能提前终止方法体
        assert_eq!(s.methods[0].body.len(), 4, "body: {:?}", s.methods[0].body);
        assert!(s.methods[0].body.iter().any(|l| l.contains("lda.str")));

        let foo = &pa.records[2];
        assert_eq!(foo.display_name, "com.example.Foo");
        assert_eq!(foo.methods[0].name, "bar");

        let global = &pa.records[3];
        assert_eq!(global.display_name, "<global>");
        assert_eq!(global.methods[0].name, "funcmain");
    }

    /// 验证 record 文本还原输出的结构完整性。
    #[test]
    fn renders_record_back_to_text() {
        let pa = PaFile::parse(SAMPLE);
        let text = pa.render_record(0).unwrap();
        assert!(text.starts_with(".record Lstd/core/String; {"));
        // `{` 应位于 .function 行尾，而不是独立成行
        assert!(text.contains(".function any Lstd/core/String;.toString(...) <static false> {"));
        // 每条指令必须独占一行（缩进行不能丢失换行符）
        assert!(text.contains("\n\tmov v0, v1\n"), "text: {text}");
        assert!(text.contains("\n\treturn\n"));
        assert!(text.trim_end().ends_with('}'));
    }
}
