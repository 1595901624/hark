//! 全局搜索引擎：对内存中已解析的 `.pa` 数据做多类别文本检索（参考 jadx）。
//!
//! 支持的类别（前端可多选，多选时结果合并、同一行命中会聚合并标注全部类别）：
//! - `class`：类名（record 展示名 / 原始名）；
//! - `method`：方法名；
//! - `field`：字段名；
//! - `string`：字符串字面量内容（指令行中双引号内的文本）；
//! - `code`：反汇编代码逐行全文；
//! - `resource`：压缩包内资源文件路径。
//!
//! 行号约定：所有命中行号均为该类 `render_record` 输出中的 1-based 行号，
//! 与前端类视图完全一致；类名 / 资源命中无行概念，记为 0。

use std::collections::HashMap;

use regex::RegexBuilder;
use serde::{Deserialize, Serialize};

use crate::project::AbcUnit;

/// 搜索类别。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SearchCategory {
    /// 类名（record 展示名 / 原始名）。
    Class,
    /// 方法名。
    Method,
    /// 字段名。
    Field,
    /// 字符串字面量内容。
    String,
    /// 反汇编代码全文。
    Code,
    /// 压缩包内资源文件路径。
    Resource,
}

impl SearchCategory {
    /// 结果聚合时类别的固定展示顺序。
    fn rank(self) -> u8 {
        match self {
            SearchCategory::Class => 0,
            SearchCategory::Method => 1,
            SearchCategory::Field => 2,
            SearchCategory::String => 3,
            SearchCategory::Code => 4,
            SearchCategory::Resource => 5,
        }
    }
}

/// 全局搜索参数（前端多选类别 + 匹配选项）。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SearchOptions {
    /// 查询文本；正则模式下为表达式。
    pub query: String,
    /// 启用的类别；为空视为参数错误。
    pub categories: Vec<SearchCategory>,
    /// 是否区分大小写。
    pub case_sensitive: bool,
    /// 是否按正则表达式解析查询。
    pub is_regex: bool,
    /// 返回结果上限，达到后提前终止并置位 [`SearchResponse::truncated`]。
    pub max_results: u32,
}

impl Default for SearchOptions {
    fn default() -> Self {
        SearchOptions {
            query: String::new(),
            categories: vec![
                SearchCategory::Class,
                SearchCategory::Method,
                SearchCategory::String,
                SearchCategory::Code,
            ],
            case_sensitive: false,
            is_regex: false,
            max_results: DEFAULT_MAX_RESULTS,
        }
    }
}

/// 默认结果上限。
const DEFAULT_MAX_RESULTS: u32 = 1000;

/// 单条搜索命中。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    /// 点击结果时应打开的节点 ID（类节点或资源节点）。
    pub class_node_id: u32,
    /// 分组标题：类展示名或资源文件路径。
    pub class_display_name: String,
    /// 所属 `.abc` 单元名；资源命中为空。
    pub unit_name: String,
    /// 命中行（1-based，对应类的 abc 视图）；类名 / 资源命中为 0。
    pub line: usize,
    /// 命中行文本（trim 后）；类名 / 资源命中为目标名称本身。
    pub text: String,
    /// 高亮区间（`text` 内的字符下标，前闭后开）。
    pub match_ranges: Vec<(usize, usize)>,
    /// 命中类别（同行多类别聚合，按固定顺序排列）。
    pub categories: Vec<SearchCategory>,
}

/// 全局搜索响应。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResponse {
    /// 命中列表（按项目树顺序排序）。
    pub hits: Vec<SearchHit>,
    /// 聚合后的命中总数。
    pub total_matches: u32,
    /// 是否因超过 [`SearchOptions::max_results`] 提前截断。
    pub truncated: bool,
    /// 搜索耗时（毫秒）。
    pub elapsed_ms: u64,
    /// 因发起了新的搜索而被取消时为 `true`（结果为空，可安全忽略）。
    pub cancelled: bool,
}

/// 搜索引擎输入快照：从 [`crate::project::Project`] 内部结构借用而来。
pub(crate) struct SearchContext<'a> {
    /// 全部 `.abc` 单元。
    pub units: &'a [AbcUnit],
    /// (单元下标, record 下标) -> 类节点 ID。
    pub class_nodes: &'a HashMap<(usize, usize), u32>,
    /// 压缩包内资源条目路径。
    pub resource_entries: &'a [String],
    /// 资源条目下标 -> 资源节点 ID。
    pub resource_nodes: &'a HashMap<usize, u32>,
}

/// 文本匹配器：大小写敏感 / 不敏感子串，或预编译正则。
enum Matcher {
    /// 大小写敏感子串。
    Sensitive(String),
    /// 大小写不敏感子串（needle 已转为小写）。
    Insensitive(String),
    /// 预编译正则。
    Regex(regex::Regex),
}

impl Matcher {
    /// 根据选项构建匹配器；空查询、无效或可匹配空串的正则会返回错误。
    fn new(query: &str, case_sensitive: bool, is_regex: bool) -> Result<Matcher, String> {
        let query = query.trim();
        if query.is_empty() {
            return Err("搜索内容为空".into());
        }
        if is_regex {
            let re = RegexBuilder::new(query)
                .case_insensitive(!case_sensitive)
                .build()
                .map_err(|e| format!("正则表达式无效: {e}"))?;
            if re.is_match("") {
                return Err("正则表达式可能匹配空字符串，请调整表达式（如去掉 `*`）".into());
            }
            Ok(Matcher::Regex(re))
        } else if case_sensitive {
            Ok(Matcher::Sensitive(query.to_string()))
        } else {
            Ok(Matcher::Insensitive(query.to_ascii_lowercase()))
        }
    }

    /// 返回文本中全部匹配区间（字节下标，前闭后开）。
    fn find_all(&self, text: &str) -> Vec<(usize, usize)> {
        let mut out = Vec::new();
        match self {
            Matcher::Sensitive(n) => find_substring(text, n, &mut out),
            Matcher::Insensitive(n) => {
                let lowered = text.to_ascii_lowercase();
                find_substring(&lowered, n, &mut out);
            }
            Matcher::Regex(re) => {
                for m in re.find_iter(text) {
                    out.push((m.start(), m.end()));
                }
            }
        }
        out
    }
}

/// 在 `hay` 中查找 `needle` 的全部不重叠出现位置。
fn find_substring(hay: &str, needle: &str, out: &mut Vec<(usize, usize)>) {
    if needle.is_empty() {
        return;
    }
    let mut start = 0;
    while let Some(pos) = hay[start..].find(needle) {
        let abs = start + pos;
        out.push((abs, abs + needle.len()));
        start = abs + needle.len();
    }
}

/// 把字节区间转换为字符区间（供前端 JS 按 UTF-16/字符高亮）。
fn to_char_ranges(text: &str, ranges: &[(usize, usize)]) -> Vec<(usize, usize)> {
    ranges
        .iter()
        .map(|(s, e)| {
            (
                text[..*s].chars().count(),
                text[..(*e).min(text.len())].chars().count(),
            )
        })
        .collect()
}

/// 合并重叠 / 相邻区间并按起点排序。
fn merge_ranges(mut ranges: Vec<(usize, usize)>) -> Vec<(usize, usize)> {
    ranges.sort_unstable();
    let mut out: Vec<(usize, usize)> = Vec::with_capacity(ranges.len());
    for (s, e) in ranges {
        match out.last_mut() {
            Some(last) if s <= last.1 => last.1 = last.1.max(e),
            _ => out.push((s, e)),
        }
    }
    out
}

/// 提取一行文本中第一个双引号字面量的内容区间（不含引号，支持 `\` 转义）。
fn quoted_literal_span(line: &str) -> Option<(usize, usize)> {
    let bytes = line.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'"' {
            let start = i + 1;
            let mut j = start;
            while j < bytes.len() {
                match bytes[j] {
                    b'\\' => j += 2,
                    b'"' => return Some((start, j)),
                    _ => j += 1,
                }
            }
            return None;
        }
        i += 1;
    }
    None
}

/// 从 `.field` 指令剩余部分提取字段名。
///
/// 优先取带类型冒号的 token 的冒号前段（`foo:Lcom/X;` -> `foo`）；
/// 无类型标注时跳过常见访问标志后取第一个 token（`public length` -> `length`）。
fn extract_field_name(field_rest: &str) -> &str {
    for token in field_rest.split_whitespace() {
        if let Some(colon) = token.find(':') {
            return &token[..colon];
        }
    }
    const FLAGS: [&str; 10] = [
        "public",
        "private",
        "protected",
        "static",
        "final",
        "volatile",
        "transient",
        "synthetic",
        "enum",
        "deprecated",
    ];
    field_rest
        .split_whitespace()
        .find(|t| !FLAGS.contains(t))
        .unwrap_or("")
}

/// 在渲染行中定位方法名的展示区间：优先锚定 `.名字(` 形式。
fn locate_method_name(line: &str, name: &str) -> Vec<(usize, usize)> {
    let anchor = format!(".{name}(");
    if let Some(pos) = line.find(&anchor) {
        return vec![(pos + 1, pos + 1 + name.len())];
    }
    if let Some(pos) = line.find(name) {
        return vec![(pos, pos + name.len())];
    }
    Vec::new()
}

/// 待聚合命中（区间先保存为字符区间，输出前统一合并）。
struct PendingHit {
    node_id: u32,
    display: String,
    unit: String,
    line: usize,
    text: String,
    ranges: Vec<(usize, usize)>,
    categories: Vec<SearchCategory>,
}

/// 命中收集器：按 (节点 ID, 行号) 聚合，控制上限并维护树序。
struct Collector {
    hits: Vec<PendingHit>,
    index: HashMap<(u32, usize), usize>,
    max: usize,
    truncated: bool,
}

impl Collector {
    fn new(max: u32) -> Collector {
        Collector {
            hits: Vec::new(),
            index: HashMap::new(),
            max: max.max(1) as usize,
            truncated: false,
        }
    }

    /// 追加一条命中；返回 `false` 表示已达上限、调用方应停止扫描。
    fn push(
        &mut self,
        node_id: u32,
        display: String,
        unit: String,
        line: usize,
        text: String,
        ranges: Vec<(usize, usize)>,
        category: SearchCategory,
    ) -> bool {
        match self.index.get(&(node_id, line)) {
            Some(&i) => {
                let hit = &mut self.hits[i];
                if !hit.categories.contains(&category) {
                    hit.categories.push(category);
                }
                hit.ranges.extend(ranges);
            }
            None => {
                self.index.insert((node_id, line), self.hits.len());
                self.hits.push(PendingHit {
                    node_id,
                    display,
                    unit,
                    line,
                    text,
                    ranges,
                    categories: vec![category],
                });
            }
        }
        if self.hits.len() >= self.max {
            self.truncated = true;
            return false;
        }
        true
    }

    /// 输出最终结果（合并区间、类别按固定顺序排序）。
    fn finish(self) -> Vec<SearchHit> {
        self.hits
            .into_iter()
            .map(|h| SearchHit {
                class_node_id: h.node_id,
                class_display_name: h.display,
                unit_name: h.unit,
                line: h.line,
                text: h.text,
                match_ranges: merge_ranges(h.ranges),
                categories: {
                    let mut cs = h.categories;
                    cs.sort_by_key(|c| c.rank());
                    cs.dedup();
                    cs
                },
            })
            .collect()
    }
}

/// 执行全局搜索。
///
/// `is_cancelled` 由调用方周期性检查（通常为新请求使旧代次失效），
/// 取消时结果为空且 `cancelled: true`。参数错误（空查询 / 无类别 /
/// 正则无效）返回 `Err`。
pub(crate) fn run(
    ctx: &SearchContext<'_>,
    opts: &SearchOptions,
    is_cancelled: &dyn Fn() -> bool,
) -> Result<SearchResponse, String> {
    let started = std::time::Instant::now();
    let query = opts.query.trim();
    if query.is_empty() {
        return Err("搜索内容为空".into());
    }
    if opts.categories.is_empty() {
        return Err("请至少选择一个搜索类别".into());
    }
    let matcher = Matcher::new(query, opts.case_sensitive, opts.is_regex)?;

    let want_class = opts.categories.contains(&SearchCategory::Class);
    let want_method = opts.categories.contains(&SearchCategory::Method);
    let want_field = opts.categories.contains(&SearchCategory::Field);
    let want_string = opts.categories.contains(&SearchCategory::String);
    let want_code = opts.categories.contains(&SearchCategory::Code);
    let want_resource = opts.categories.contains(&SearchCategory::Resource);
    let scan_lines = want_method || want_field || want_string || want_code;

    let mut collector = Collector::new(opts.max_results);
    let mut cancelled = false;

    'outer: for (ui, unit) in ctx.units.iter().enumerate() {
        if is_cancelled() {
            cancelled = true;
            break;
        }
        for (ri, rec) in unit.pa.records.iter().enumerate() {
            if is_cancelled() {
                cancelled = true;
                break 'outer;
            }
            let Some(&node_id) = ctx.class_nodes.get(&(ui, ri)) else {
                continue;
            };

            // 类名命中：无行概念，标题即目标名称
            if want_class {
                let ranges = matcher.find_all(&rec.display_name);
                if !ranges.is_empty() || !matcher.find_all(&rec.raw_name).is_empty() {
                    let ranges = to_char_ranges(&rec.display_name, &ranges);
                    if !collector.push(
                        node_id,
                        rec.display_name.clone(),
                        unit.name.clone(),
                        0,
                        rec.display_name.clone(),
                        ranges,
                        SearchCategory::Class,
                    ) {
                        break 'outer;
                    }
                }
            }

            if !scan_lines {
                continue;
            }
            let Some(body) = unit.pa.render_record(ri) else {
                continue;
            };
            let mut method_idx = 0usize;
            let mut field_idx = 0usize;
            for (li, line) in body.lines().enumerate() {
                if li % 2048 == 0 && is_cancelled() {
                    cancelled = true;
                    break 'outer;
                }
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                let lineno = li + 1;
                let mut is_header = false;
                if trimmed.starts_with(".function") {
                    is_header = true;
                    if want_method && method_idx < rec.methods.len() {
                        let name = rec.methods[method_idx].name.as_str();
                        if !matcher.find_all(name).is_empty() {
                            let ranges =
                                to_char_ranges(trimmed, &locate_method_name(trimmed, name));
                            if !collector.push(
                                node_id,
                                rec.display_name.clone(),
                                unit.name.clone(),
                                lineno,
                                trimmed.to_string(),
                                ranges,
                                SearchCategory::Method,
                            ) {
                                break 'outer;
                            }
                        }
                    }
                    method_idx += 1;
                } else if let Some(rest) = trimmed.strip_prefix(".field") {
                    is_header = true;
                    if want_field && field_idx < rec.fields.len() {
                        let name = extract_field_name(rest.trim());
                        if !name.is_empty() && !matcher.find_all(name).is_empty() {
                            let ranges = match trimmed.find(name) {
                                Some(pos) => vec![(pos, pos + name.len())],
                                None => Vec::new(),
                            };
                            let ranges = to_char_ranges(trimmed, &ranges);
                            if !collector.push(
                                node_id,
                                rec.display_name.clone(),
                                unit.name.clone(),
                                lineno,
                                trimmed.to_string(),
                                ranges,
                                SearchCategory::Field,
                            ) {
                                break 'outer;
                            }
                        }
                    }
                    field_idx += 1;
                }

                // 代码全文：覆盖包括声明行在内的所有非空行
                if want_code {
                    let ranges = matcher.find_all(trimmed);
                    if !ranges.is_empty() {
                        let ranges = to_char_ranges(trimmed, &ranges);
                        if !collector.push(
                            node_id,
                            rec.display_name.clone(),
                            unit.name.clone(),
                            lineno,
                            trimmed.to_string(),
                            ranges,
                            SearchCategory::Code,
                        ) {
                            break 'outer;
                        }
                    }
                }
                // 字符串字面量：仅指令行中双引号内的内容
                if !is_header && want_string {
                    if let Some((cs, ce)) = quoted_literal_span(trimmed) {
                        let content = &trimmed[cs..ce];
                        let mut ranges = matcher.find_all(content);
                        if !ranges.is_empty() {
                            for r in &mut ranges {
                                r.0 += cs;
                                r.1 += cs;
                            }
                            let ranges = to_char_ranges(trimmed, &ranges);
                            if !collector.push(
                                node_id,
                                rec.display_name.clone(),
                                unit.name.clone(),
                                lineno,
                                trimmed.to_string(),
                                ranges,
                                SearchCategory::String,
                            ) {
                                break 'outer;
                            }
                        }
                    }
                }
            }
        }
    }

    // 资源文件路径检索
    if !cancelled && want_resource {
        for (i, path) in ctx.resource_entries.iter().enumerate() {
            if is_cancelled() {
                cancelled = true;
                break;
            }
            let Some(&node_id) = ctx.resource_nodes.get(&i) else {
                continue;
            };
            let ranges = matcher.find_all(path);
            if !ranges.is_empty() {
                let ranges = to_char_ranges(path, &ranges);
                if !collector.push(
                    node_id,
                    path.clone(),
                    String::new(),
                    0,
                    path.clone(),
                    ranges,
                    SearchCategory::Resource,
                ) {
                    break;
                }
            }
        }
    }

    if cancelled {
        return Ok(SearchResponse {
            hits: Vec::new(),
            total_matches: 0,
            truncated: false,
            elapsed_ms: started.elapsed().as_millis() as u64,
            cancelled: true,
        });
    }

    let truncated = collector.truncated;
    let hits = collector.finish();
    let total_matches = hits.len() as u32;
    Ok(SearchResponse {
        hits,
        total_matches,
        truncated,
        elapsed_ms: started.elapsed().as_millis() as u64,
        cancelled: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pa::PaFile;

    /// 构造与 `pa.rs` 测试一致的样例数据及节点映射。
    struct Sample {
        units: Vec<AbcUnit>,
        class_nodes: HashMap<(usize, usize), u32>,
        resource_entries: Vec<String>,
        resource_nodes: HashMap<usize, u32>,
    }

    impl Sample {
        fn new() -> Sample {
            let pa = PaFile::parse(
                r#"
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
"#,
            );
            let units = vec![AbcUnit {
                name: "entry.abc".into(),
                pa,
                names: Default::default(),
            }];
            let mut class_nodes = HashMap::new();
            for ri in 0..units[0].pa.records.len() {
                class_nodes.insert((0, ri), 100 + ri as u32);
            }
            Sample {
                units,
                class_nodes,
                resource_entries: Vec::new(),
                resource_nodes: HashMap::new(),
            }
        }

        fn ctx(&self) -> SearchContext<'_> {
            SearchContext {
                units: &self.units,
                class_nodes: &self.class_nodes,
                resource_entries: &self.resource_entries,
                resource_nodes: &self.resource_nodes,
            }
        }
    }

    fn opts(query: &str, categories: &[SearchCategory]) -> SearchOptions {
        SearchOptions {
            query: query.into(),
            categories: categories.to_vec(),
            case_sensitive: false,
            is_regex: false,
            max_results: DEFAULT_MAX_RESULTS,
        }
    }

    fn run_ok(ctx: &SearchContext<'_>, opts: &SearchOptions) -> Result<SearchResponse, String> {
        run(ctx, opts, &|| false)
    }

    /// 类名命中：无行号，标题为类展示名。
    #[test]
    fn finds_class_names() {
        let sample = Sample::new();
        let ctx = sample.ctx();
        let resp = run_ok(&ctx, &opts("example", &[SearchCategory::Class]))
            .unwrap();
        assert_eq!(resp.hits.len(), 1);
        let hit = &resp.hits[0];
        assert_eq!(hit.class_display_name, "com.example.Foo");
        assert_eq!(hit.line, 0);
        assert_eq!(hit.categories, vec![SearchCategory::Class]);
        assert_eq!(hit.match_ranges, vec![(4, 11)]);
        assert!(!resp.truncated);
    }

    /// 外部 record 同样参与类名检索。
    #[test]
    fn finds_external_class() {
        let sample = Sample::new();
        let ctx = sample.ctx();
        let resp = run_ok(&ctx, &opts("foreign", &[SearchCategory::Class]))
            .unwrap();
        assert_eq!(resp.hits.len(), 1);
        assert_eq!(resp.hits[0].class_display_name, "std.core.Foreign");
    }

    /// 方法名命中：行号对准 `.function` 头行（1-based）。
    #[test]
    fn finds_method_names() {
        let sample = Sample::new();
        let ctx = sample.ctx();
        let resp = run_ok(&ctx, &opts("toString", &[SearchCategory::Method]))
            .unwrap();
        assert_eq!(resp.hits.len(), 1);
        let hit = &resp.hits[0];
        assert_eq!(hit.class_display_name, "std.core.String");
        assert_eq!(hit.line, 6);
        assert!(hit.text.starts_with(".function"));
        assert_eq!(hit.match_ranges, vec![(32, 40)]);
    }

    /// 字段名命中：行号对准 `.field` 行，且只匹配字段名本身。
    #[test]
    fn finds_field_names() {
        let sample = Sample::new();
        let ctx = sample.ctx();
        let resp = run_ok(&ctx, &opts("length", &[SearchCategory::Field]))
            .unwrap();
        assert_eq!(resp.hits.len(), 1);
        let hit = &resp.hits[0];
        assert_eq!(hit.line, 4);
        assert_eq!(hit.text, ".field public length");
        assert_eq!(hit.match_ranges, vec![(14, 20)]);
    }

    /// 字符串类别只匹配引号内字面量内容，不含指令与引号。
    #[test]
    fn finds_string_literals_only() {
        let sample = Sample::new();
        let ctx = sample.ctx();
        // "lda" 只出现在指令助记符里，不应命中字符串类别
        let resp = run_ok(&ctx, &opts("lda", &[SearchCategory::String]))
            .unwrap();
        assert!(resp.hits.is_empty());
        let resp = run_ok(&ctx, &opts("} inside", &[SearchCategory::String]))
            .unwrap();
        assert_eq!(resp.hits.len(), 1);
        let hit = &resp.hits[0];
        assert_eq!(hit.line, 8);
        let (s, e) = hit.match_ranges[0];
        assert!(hit.text.is_char_boundary(s) && hit.text.is_char_boundary(e));
        assert_eq!(&hit.text[s..e], "} inside");
    }

    /// 代码类别逐行匹配；多类别同行命中聚合到一条并标注全部类别。
    #[test]
    fn aggregates_categories_on_same_line() {
        let sample = Sample::new();
        let ctx = sample.ctx();
        let resp = run_ok(
            &ctx,
            &opts(
                "length",
                &[SearchCategory::Field, SearchCategory::Code],
            ),
        )
        .unwrap();
        assert_eq!(resp.hits.len(), 1, "hits: {:?}", resp.hits);
        assert_eq!(resp.hits[0].categories, vec![SearchCategory::Field, SearchCategory::Code]);
    }

    /// 大小写开关行为。
    #[test]
    fn respects_case_sensitivity() {
        let sample = Sample::new();
        let ctx = sample.ctx();
        let mut o = opts("MOV V0", &[SearchCategory::Code]);
        let ci = run_ok(&ctx, &o.clone()).unwrap();
        assert_eq!(ci.hits.len(), 1);
        o.case_sensitive = true;
        let cs = run_ok(&ctx, &o).unwrap();
        assert!(cs.hits.is_empty());
    }

    /// 正则模式：命中与非法表达式错误。
    #[test]
    fn supports_regex() {
        let sample = Sample::new();
        let ctx = sample.ctx();
        let mut o = opts(r#"lda\.str "brace"#, &[SearchCategory::Code]);
        o.is_regex = true;
        let resp = run_ok(&ctx, &o).unwrap();
        assert_eq!(resp.hits.len(), 1);
        assert_eq!(resp.hits[0].line, 8);

        o.query = "(unclosed".into();
        assert!(run_ok(&ctx, &o).is_err());
        // 可匹配空串的正则必须拒绝
        o.query = "x*".into();
        assert!(run_ok(&ctx, &o).is_err());
    }

    /// 达到上限时截断。
    #[test]
    fn truncates_at_limit() {
        let sample = Sample::new();
        let ctx = sample.ctx();
        let mut o = opts("return", &[SearchCategory::Code]);
        o.max_results = 2;
        let resp = run_ok(&ctx, &o).unwrap();
        assert_eq!(resp.hits.len(), 2);
        assert!(resp.truncated);
        assert_eq!(resp.total_matches, 2);
    }

    /// 参数校验与取消。
    #[test]
    fn validates_and_cancels() {
        let sample = Sample::new();
        let ctx = sample.ctx();
        assert!(run_ok(&ctx, &opts("", &[SearchCategory::Code])).is_err());
        assert!(run_ok(&ctx, &opts("x", &[])).is_err());
        let cancelled = run(&ctx, &opts("mov", &[SearchCategory::Code]), &|| true).unwrap();
        assert!(cancelled.cancelled);
        assert!(cancelled.hits.is_empty());
    }

    /// 资源文件路径检索。
    #[test]
    fn finds_resource_paths() {
        let mut sample = Sample::new();
        sample.resource_entries = vec!["ets/modules/page.abc.map".to_string()];
        sample.resource_nodes.insert(0usize, 900u32);
        let ctx = sample.ctx();
        let resp = run_ok(&ctx, &opts("modules", &[SearchCategory::Resource]))
            .unwrap();
        assert_eq!(resp.hits.len(), 1);
        let hit = &resp.hits[0];
        assert_eq!(hit.class_node_id, 900);
        assert_eq!(hit.class_display_name, "ets/modules/page.abc.map");
        assert_eq!(hit.line, 0);
    }
}
