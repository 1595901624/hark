//! `.function` 签名的结构化解析。
//!
//! pandasm 函数头形如：
//! `.function <返回类型> <RecordName>.<methodName>(<参数类型列表>) <元数据> {`
//! 其中元数据形如 `<static false, esfunc false>`；无归属的全局函数
//! （如 `funcmain`）没有 RecordName 前缀。

use super::instr;

/// 一个方法签名的结构化表示。
#[derive(Debug, Clone)]
pub struct Sig {
    /// 返回类型文本，如 `any` / `void` / `u64`。
    pub ret: String,
    /// 所属 record 的原始名（全局函数为空串）。
    pub owner: String,
    /// 方法短名（已去除混淆前缀 `#*#`）。
    pub name: String,
    /// 参数类型列表（不含 this）。
    pub params: Vec<String>,
    /// 是否静态方法。
    pub is_static: bool,
    /// 是否异步相关（元数据或名称提示）。
    pub is_async_hint: bool,
}

/// 去除工具链混淆产生的名字前缀（如 `#*#main` → `main`）。
///
/// 形如 `#123456789#e2` 的混淆名取末段真实短名 `e2`。
pub fn clean_name(name: &str) -> String {
    let mut n = name.trim().to_string();
    loop {
        let stripped = n
            .trim_start_matches("#*#")
            .trim_start_matches('#')
            .trim_start_matches('*');
        if stripped.len() == n.len() {
            break;
        }
        n = stripped.to_string();
    }
    // 内层 hash 分隔：取最后一个非空段
    if n.contains('#') {
        if let Some(seg) = n.rsplit('#').find(|s| !s.is_empty()) {
            n = seg.to_string();
        }
    }
    if n.is_empty() {
        "<anonymous>".to_string()
    } else {
        n
    }
}

/// 通过方法体指令粗判 async 方法（出现 asyncfunctionenter 等指令）。
pub fn is_method_async_hint(body: &[String]) -> bool {
    body.iter().any(|l| {
        let t = l.trim_start();
        t.starts_with("asyncfunctionenter") || t.starts_with("async_function_enter")
    })
}

/// 解析 `.function` 之后的剩余签名字符串。
///
/// 输入示例：`any Lstd/core/String;.toString(...) <static false>`
/// 返回结构化签名；无法识别时各字段尽量保留原文。
pub fn parse(signature: &str) -> Sig {
    // 容忍未剥离的函数体起始大括号
    let text = signature.trim().trim_end_matches('{').trim();
    // 元数据 `<...>`
    let (body, meta) = match text.find('<') {
        Some(pos) if text.ends_with('>') => (&text[..pos], &text[pos + 1..text.len() - 1]),
        _ => (text, ""),
    };
    let is_static = meta.split(',').any(|f| {
        let f = f.trim();
        f == "static" || f.starts_with("static true")
    });
    let is_async_hint = meta.contains("async");

    // 参数列表（第一个 '(' 与最后一个 ')' 之间）
    let paren_open = body.find('(').unwrap_or(body.len());
    let paren_close = body.rfind(')').unwrap_or(body.len());
    let head = &body[..paren_open];
    let params_text = if paren_open < body.len() && paren_close > paren_open {
        &body[paren_open + 1..paren_close.min(body.len())]
    } else {
        ""
    };

    // head = `<返回类型> <限定名>`；限定名取最后一个空格后的 token
    let qualified = head.trim().rsplit(' ').next().unwrap_or("").trim();
    let (owner, raw_name) = match qualified.rfind('.') {
        Some(pos) => (
            qualified[..pos].to_string(),
            qualified[pos + 1..].to_string(),
        ),
        None => (String::new(), qualified.to_string()),
    };

    let params = split_params(params_text);

    Sig {
        ret: head.trim().split(' ').next().unwrap_or("any").to_string(),
        owner,
        name: clean_name(&raw_name),
        params,
        is_static,
        is_async_hint,
    }
}

/// 拆分参数类型列表（顶层逗号切分；`(...)` 变参折叠为一个 rest 参数）。
fn split_params(text: &str) -> Vec<String> {
    let text = text.trim();
    if text.is_empty() {
        return vec![];
    }
    // 变参标记：pandasm 用 `...` 表示剩余参数
    if text == "..." || text.starts_with("...") {
        return vec!["...rest".to_string()];
    }
    instr::split_top_commas(text)
        .into_iter()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

impl Sig {
    /// 是否构造函数。
    pub fn is_ctor(&self) -> bool {
        self.name == "ctor"
    }

    /// 是否模块入口函数（funcmain / func_main / #*#main）。
    pub fn is_module_main(&self) -> bool {
        matches!(self.name.as_str(), "funcmain" | "func_main" | "main") && self.owner.is_empty()
    }

    /// 是否工具链合成的初始化方法（模块入口 / static_initializer）。
    ///
    /// 这类方法的寄存器是状态机槽位而非调用实参，还原时不绑定 this 与参数。
    pub fn is_synthetic(&self) -> bool {
        self.is_module_main()
            || self.name.contains("static_initializer")
            || self.name.starts_with("func_main")
    }

    /// 把 panda 类型名映射为 ArkTS 类型标注。
    pub fn ts_type(panda_type: &str) -> &'static str {
        match panda_type {
            "i8" | "i16" | "i32" | "i64" | "u8" | "u16" | "u32" | "u64" | "f32" | "f64" => "number",
            "bool" => "boolean",
            "void" => "void",
            "any" | "#Any" => "any",
            _ => "any",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_instance_method_signature() {
        let s = parse("any Lstd/core/String;.toString(...) <static false, esfunc false>");
        assert_eq!(s.ret, "any");
        assert_eq!(s.owner, "Lstd/core/String;");
        assert_eq!(s.name, "toString");
        assert_eq!(s.params, vec!["...rest"]);
        assert!(!s.is_static);
    }

    #[test]
    fn parses_static_global_and_ctor() {
        let s = parse("void Lcom/example/Foo;.bar(i32, any) <static true> {");
        assert!(s.is_static);
        assert_eq!(s.params.len(), 2);
        assert_eq!(Sig::ts_type(&s.params[0]), "number");
        assert!(!s.is_ctor());

        let c = parse("any LEntry;.ctor(any) <static false>");
        assert!(c.is_ctor());
        assert_eq!(c.owner, "LEntry;");

        let g = parse("u64 funcmain() <static true>");
        assert_eq!(g.owner, "");
        assert!(g.is_module_main());
        assert_eq!(g.ret, "u64");
    }

    #[test]
    fn cleans_obfuscated_names() {
        assert_eq!(clean_name("#*#main"), "main");
        assert_eq!(clean_name("ctor"), "ctor");
        assert_eq!(clean_name(""), "<anonymous>");
    }
}
