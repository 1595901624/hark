//! 字面量池 dump 的解析与调用目标名称解析。
//!
//! `ark_disasm --dump-literal-pools` 会在输出末尾追加字面量池段落，
//! 形如（不同版本细节有差异，这里做宽容解析）：
//!
//! ```text
//! .literal_array 5 {
//!     [string: "toString"]
//!     [i32: 0x1]
//! }
//! ```
//!
//! 方法调用指令的立即数操作数索引这类字面量数组；首项为字符串的
//! 数组通常是方法引用。解析结果供反编译器把 `callthis0 0x5, v0`
//! 还原为真实调用名。

use std::collections::HashMap;

/// 字面量池名称表。
#[derive(Debug, Clone, Default)]
pub struct Names {
    /// 字面量数组索引 -> 首个字符串项。
    map: HashMap<i64, String>,
}

impl Names {
    /// 查询调用立即数对应的方法 / 全局名。
    pub fn get(&self, id: i64) -> Option<&str> {
        self.map.get(&id).map(|s| s.as_str())
    }

    /// 表大小。
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn len(&self) -> usize {
        self.map.len()
    }

    /// 是否为空。
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn is_empty(&self) -> bool {
        self.map.is_empty()
    }

    /// 插入一条字面量名称（主要供测试构造名称表）。
    #[cfg(test)]
    pub fn set(&mut self, id: i64, name: &str) {
        self.map.insert(id, name.to_string());
    }
}

/// 判断一行是否是字面量池段落的数组头，返回其索引。
fn parse_array_header(line: &str) -> Option<i64> {
    let t = line.trim();
    let rest = t
        .strip_prefix(".literal_array")
        .or_else(|| t.strip_prefix(".literalarray"))
        .or_else(|| t.strip_prefix(".literal_arrays"))?;
    let num: String = rest
        .trim()
        .trim_start_matches(':')
        .chars()
        .take_while(|c| c.is_ascii_digit() || *c == '-')
        .collect();
    num.parse::<i64>().ok()
}

/// 从条目行 `[kind: value]` 中提取首个字符串值。
fn parse_item_string(line: &str) -> Option<String> {
    let t = line.trim();
    if !(t.starts_with('[') && t.contains("string")) {
        return None;
    }
    // 提取引号内的内容
    let open = t.find('"')?;
    let close = t.rfind('"')?;
    if close <= open {
        return None;
    }
    Some(t[open + 1..close].to_string())
}

/// 从完整的 `.pa` 文本中提取字面量池名称表。
pub fn parse_literal_names(text: &str) -> Names {
    let mut map = HashMap::new();
    let mut current: Option<i64> = None;
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        if let Some(idx) = parse_array_header(trimmed) {
            current = Some(idx);
            continue;
        }
        if trimmed.starts_with('[') {
            if let (Some(idx), Some(s)) = (current, parse_item_string(trimmed)) {
                map.entry(idx).or_insert(s);
            }
            continue;
        }
        if trimmed.starts_with('.') {
            // 进入其他段落
            current = None;
        }
    }
    Names { map }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_literal_pool_dump() {
        let text = r#"
# ====================
# LITERAL ARRAYS
# ====================

.literal_array 0 {
	[i32: 0x1]
	[string: "console"]
}

.literal_array 5 {
	[string: "log"]
}

.record Lstd/core/String; {
}
"#;
        let names = parse_literal_names(text);
        assert_eq!(names.get(0), Some("console"));
        assert_eq!(names.get(5), Some("log"));
        assert_eq!(names.get(9), None);
        assert_eq!(names.len(), 2);
    }

    #[test]
    fn tolerates_missing_or_malformed_sections() {
        let names = parse_literal_names(".record LFoo; {\n}\n");
        assert!(names.is_empty());
        let names2 = parse_literal_names(".literal_array x {\n[string: broken\n}\n");
        assert!(names2.is_empty());
    }
}
