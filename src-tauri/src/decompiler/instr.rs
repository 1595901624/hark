//! 方舟字节码反汇编文本（pandasm）的指令级解析与操作码分类。
//!
//! 把 `.pa` 方法体中的原始行解析为带标签、操作码与操作数的结构
//! （[`Line`] / [`Insn`]），并按「操作数形态」而非精确助记符分类，
//! 以兼容不同版本 ark_disasm 的指令命名差异。

use std::collections::HashMap;

/// 指令操作数。
#[derive(Debug, Clone, PartialEq)]
pub enum Operand {
    /// 寄存器 `vN`。
    Reg(u16),
    /// 整数立即数（十进制 / 十六进制）。
    Imm(i64),
    /// 浮点立即数。
    Float(f64),
    /// 布尔字面量。
    Bool(bool),
    /// 字符串字面量（已反转义）。
    Str(String),
    /// 标识符 / 方法引用等非字面量 token。
    Id(String),
    /// `null`。
    Null,
    /// `undefined`。
    Undefined,
}

impl Operand {
    /// 寄存器编号；非寄存器操作数返回 `None`。
    pub fn as_reg(&self) -> Option<u16> {
        match self {
            Operand::Reg(r) => Some(*r),
            _ => None,
        }
    }

    /// 整数立即数；浮点数会截断，其余返回 `None`。
    pub fn as_imm(&self) -> Option<i64> {
        match self {
            Operand::Imm(i) => Some(*i),
            Operand::Float(f) => Some(*f as i64),
            _ => None,
        }
    }

    /// 字符串字面量内容。
    pub fn as_str(&self) -> Option<&str> {
        match self {
            Operand::Str(s) | Operand::Id(s) => Some(s),
            _ => None,
        }
    }
}

/// 一条指令：可选的行首标签 + 操作码 + 操作数。
#[derive(Debug, Clone)]
pub struct Insn {
    /// 行首标签，如 `L0001:` 中的 `L0001`。
    pub label: Option<String>,
    /// 操作码，如 `ldai`。
    pub opcode: String,
    /// 操作数列表。
    pub operands: Vec<Operand>,
}

/// 方法体中的一行：指令、独立标签或 `.catch` 等伪指令。
#[derive(Debug, Clone)]
pub enum Line {
    /// 一条指令（可能带行首标签）。
    Insn(Insn),
    /// 独立成行的标签。
    Label(String),
    /// 其他伪指令 / 无法解析的行，原样保留文本。
    Directive(String),
}

/// 判断字符是否可出现在标签名中。
fn is_label_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '_' | '$' | '.')
}

/// 去掉行尾注释（`#` 起，忽略字符串字面量内的 `#`）。
pub fn strip_comment(line: &str) -> &str {
    let mut in_str: Option<char> = None;
    let mut escaped = false;
    for (i, c) in line.char_indices() {
        if let Some(q) = in_str {
            if escaped {
                escaped = false;
            } else if c == '\\' {
                escaped = true;
            } else if c == q {
                in_str = None;
            }
            continue;
        }
        match c {
            '"' | '\'' => in_str = Some(c),
            '#' => return &line[..i],
            _ => {}
        }
    }
    line
}

/// 反转义 pandasm 字符串字面量的内容（不含外层引号）。
pub fn unescape(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut chars = raw.chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('n') => out.push('\n'),
            Some('r') => out.push('\r'),
            Some('t') => out.push('\t'),
            Some('0') => out.push('\0'),
            Some('u') => {
                // \uXXXX 或 \u{XXXX}
                let mut hex: String = chars.by_ref().take_while(|c| c.is_ascii_hexdigit()).collect();
                if hex.is_empty() && chars.clone().next() == Some('{') {
                    chars.next();
                    hex = chars.by_ref().take_while(|c| *c != '}').collect();
                }
                if let Ok(v) = u32::from_str_radix(&hex, 16) {
                    if let Some(ch) = char::from_u32(v) {
                        out.push(ch);
                    }
                }
            }
            Some(other) => out.push(other),
            None => out.push('\\'),
        }
    }
    out
}

/// 解析单个操作数 token。
pub fn parse_operand(tok: &str) -> Operand {
    let tok = tok.trim();
    if tok.len() >= 2 && tok.starts_with('"') && tok.ends_with('"') {
        return Operand::Str(unescape(&tok[1..tok.len() - 1]));
    }
    if tok.len() >= 2 && tok.starts_with('\'') && tok.ends_with('\'') {
        return Operand::Str(unescape(&tok[1..tok.len() - 1]));
    }
    if let Some(rest) = tok.strip_prefix('v') {
        if !rest.is_empty() && rest.chars().all(|c| c.is_ascii_digit()) {
            if let Ok(n) = rest.parse::<u16>() {
                return Operand::Reg(n);
            }
        }
    }
    match tok {
        "true" => return Operand::Bool(true),
        "false" => return Operand::Bool(false),
        "null" => return Operand::Null,
        "undefined" => return Operand::Undefined,
        _ => {}
    }
    if let Ok(v) = parse_int(tok) {
        return Operand::Imm(v);
    }
    if let Ok(f) = tok.parse::<f64>() {
        if tok.contains('.') || tok.contains('e') || tok.contains('E') {
            return Operand::Float(f);
        }
    }
    Operand::Id(tok.to_string())
}

/// 解析整数字面量（支持十进制 / 十六进制 / 二进制，允许负号）。
fn parse_int(tok: &str) -> Result<i64, ()> {
    let (neg, body) = match tok.strip_prefix('-') {
        Some(b) => (true, b),
        None => (false, tok),
    };
    let value = if let Some(h) = body.strip_prefix("0x").or_else(|| body.strip_prefix("0X")) {
        i64::from_str_radix(h, 16).map_err(|_| ())?
    } else if let Some(b) = body.strip_prefix("0b").or_else(|| body.strip_prefix("0B")) {
        i64::from_str_radix(b, 2).map_err(|_| ())?
    } else {
        if body.is_empty() || !body.chars().all(|c| c.is_ascii_digit()) {
            return Err(());
        }
        body.parse::<i64>().map_err(|_| ())?
    };
    Ok(if neg { -value } else { value })
}

/// 在顶层（引号外）按逗号切分操作数串。
fn split_operands(rest: &str) -> Vec<String> {    let mut parts = vec![];
    let mut cur = String::new();
    let mut in_str: Option<char> = None;
    let mut escaped = false;
    for c in rest.chars() {
        if let Some(q) = in_str {
            cur.push(c);
            if escaped {
                escaped = false;
            } else if c == '\\' {
                escaped = true;
            } else if c == q {
                in_str = None;
            }
            continue;
        }
        match c {
            '"' | '\'' => {
                in_str = Some(c);
                cur.push(c);
            }
            ',' => {
                parts.push(cur.trim().to_string());
                cur.clear();
            }
            _ => cur.push(c),
        }
    }
    if !cur.trim().is_empty() {
        parts.push(cur.trim().to_string());
    }
    parts
}

/// 顶层逗号切分的公开封装（供签名参数解析等复用）。
pub fn split_top_commas(text: &str) -> Vec<String> {
    split_operands(text)
}

/// 解析一行方法体文本为 [`Line`]。
pub fn parse_line(raw: &str) -> Line {
    let code = strip_comment(raw).trim();
    if code.is_empty() {
        return Line::Directive(String::new());
    }
    if code.starts_with('.') || code.starts_with('#') {
        return Line::Directive(code.to_string());
    }

    let mut label = None;
    let mut rest = code;
    // 行首标签：ident 后紧跟 ':'
    let colon = code.find(':').unwrap_or(0);
    if colon > 0 {
        let head = &code[..colon];
        if !head.is_empty()
            && head.chars().next().map(|c| c.is_ascii_alphabetic() || c == '_' || c == '$').unwrap_or(false)
            && head.chars().all(is_label_char)
        {
            label = Some(head.to_string());
            rest = code[colon + 1..].trim_start();
        }
    }

    if rest.is_empty() {
        return match label {
            Some(l) => Line::Label(l),
            None => Line::Directive(code.to_string()),
        };
    }

    let split_at = rest
        .char_indices()
        .find(|(_, c)| c.is_whitespace())
        .map(|(i, _)| i)
        .unwrap_or(rest.len());
    let opcode = rest[..split_at].to_string();
    let ops_text = rest[split_at..].trim();
    let operands = split_operands(ops_text)
        .into_iter()
        .map(|t| parse_operand(&t))
        .collect();

    Line::Insn(Insn { label, opcode, operands })
}

/// 批量解析方法体行，过滤空行。
#[cfg_attr(not(test), allow(dead_code))]
pub fn parse_lines(body: &[String]) -> Vec<Line> {
    body.iter().filter_map(|l| match parse_line(l) {
        Line::Directive(d) if d.is_empty() => None,
        other => Some(other),
    }).collect()
}

// ---------- 操作码分类 ----------

/// 比较谓词种类。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Cmp {
    Eq,
    Ne,
    Lt,
    Le,
    Gt,
    Ge,
    StrictEq,
    StrictNe,
}

/// 跳转形式。
#[derive(Debug, Clone)]
pub enum Jump {
    /// 无条件跳转。
    Always,
    /// 条件跳转：`(比较种类, 是否与零值比较)`。零值比较以累加器为左值，
    /// 真值语义为 JS truthiness。
    Cond(Cmp, bool),
}

/// 解码跳转类操作码（`jmp` / `jeqz` / `jne v0` 等）。
pub fn decode_jump(op: &str) -> Option<Jump> {
    let base = op.strip_prefix('j')?;
    let base = base.split('.').next().unwrap_or(base);
    if base == "mp" || base == "mpaddr" {
        return Some(Jump::Always);
    }
    let (root, zero) = match base.strip_suffix('z') {
        Some(r) => (r, true),
        None => (base, false),
    };
    let cmp = match root {
        "" if zero => Cmp::Eq,
        "eq" => Cmp::Eq,
        "ne" => Cmp::Ne,
        "lt" => Cmp::Lt,
        "le" => Cmp::Le,
        "gt" => Cmp::Gt,
        "ge" => Cmp::Ge,
        "steq" | "stricteq" => Cmp::StrictEq,
        "stnoteq" | "strictnoteq" => Cmp::StrictNe,
        "n" if zero => Cmp::Ne,
        // jmpz 视作 jeqz 的别名
        "mp" if zero => Cmp::Eq,
        _ => return None,
    };
    Some(Jump::Cond(cmp, zero))
}

/// 提取跳转目标标签名（最后一个 Id 操作数）。
pub fn jump_target(insn: &Insn) -> Option<&str> {
    insn.operands.iter().rev().find_map(|o| match o {
        Operand::Id(s) => Some(s.as_str()),
        _ => None,
    })
}

/// 算术 / 位运算种类。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AluOp {
    Add,
    Sub,
    Mul,
    Div,
    Mod,
    BitAnd,
    BitOr,
    BitXor,
    Shl,
    Shr,
    UShr,
    Neg,
    Not,
}

/// 算术指令的操作数形态。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AluForm {
    /// 双寄存器 → 累加器，如 `add2 v1, v2`（acc = v1 OP v2）。
    Acc2,
    /// 寄存器就地复合赋值，如 `addi v0, 0x1`（v0 OP= imm）。
    InPlace,
    /// 单寄存器一元运算 → 累加器，如 `neg v0`。
    UnaryToAcc,
}

/// 解码算术 / 位运算操作码。
pub fn decode_alu(op: &str) -> Option<(AluOp, AluForm)> {
    let base = op.split('.').next().unwrap_or(op);
    // inc/dec 是特殊的就地加减
    if let Some(root) = base.strip_prefix("inc") {
        if root.is_empty() || root.starts_with('i') || root.chars().all(|c| c.is_ascii_digit()) {
            return Some((AluOp::Add, AluForm::InPlace));
        }
    }
    if let Some(root) = base.strip_prefix("dec") {
        if root.is_empty() || root.starts_with('i') || root.chars().all(|c| c.is_ascii_digit()) {
            return Some((AluOp::Sub, AluForm::InPlace));
        }
    }
    // 剥离宽度后缀（.64 / .32 等）
    let name = base;
    // 形态 1：双寄存器（add2 / sub2 ...）
    if let Some(root) = name.strip_suffix('2') {
        if let Some(a) = alu_root(root) {
            return Some((a, AluForm::Acc2));
        }
    }
    // 形态 2：寄存器 + 立即数（addi / subi ...）
    if let Some(root) = name.strip_suffix('i') {
        if let Some(a) = alu_root(root) {
            return Some((a, AluForm::InPlace));
        }
    }
    // 形态 3：一元（neg / not）
    if let Some(a) = alu_root(name) {
        if matches!(a, AluOp::Neg | AluOp::Not) {
            return Some((a, AluForm::UnaryToAcc));
        }
    }
    None
}

/// 操作码词根到算术种类的映射。
fn alu_root(root: &str) -> Option<AluOp> {
    match root {
        "add" => Some(AluOp::Add),
        "sub" => Some(AluOp::Sub),
        "mul" => Some(AluOp::Mul),
        "div" => Some(AluOp::Div),
        "mod" => Some(AluOp::Mod),
        "and" => Some(AluOp::BitAnd),
        "or" => Some(AluOp::BitOr),
        "xor" => Some(AluOp::BitXor),
        "shl" => Some(AluOp::Shl),
        "shr" => Some(AluOp::Shr),
        "ashr" => Some(AluOp::UShr),
        "neg" => Some(AluOp::Neg),
        "not" => Some(AluOp::Not),
        _ => None,
    }
}

/// 比较赋值类操作码（结果写入累加器，如 `eq v1, v2`）。
pub fn decode_cmp_set(op: &str) -> Option<Cmp> {
    let base = op.split('.').next().unwrap_or(op);
    match base {
        "eq" => Some(Cmp::Eq),
        "not_eq" | "ne" => Some(Cmp::Ne),
        "lt" => Some(Cmp::Lt),
        "le" => Some(Cmp::Le),
        "gt" => Some(Cmp::Gt),
        "ge" => Some(Cmp::Ge),
        "strict_eq" | "steq" => Some(Cmp::StrictEq),
        "strict_not_eq" | "stnoteq" => Some(Cmp::StrictNe),
        _ => None,
    }
}

/// 调用指令形态。
#[derive(Debug, Clone, Copy)]
pub struct CallShape {
    /// 是否携带 this（第一个寄存器参数为 this）。
    pub has_this: bool,
    /// 参数个数确定（Fixed(n)）还是由寄存器连续区间给出（Range）。
    pub mode: CallMode,
}

/// 调用参数传递方式。
#[derive(Debug, Clone, Copy)]
pub enum CallMode {
    /// 固定个数参数，寄存器逐个列出。
    Fixed(usize),
    /// 参数个数在立即数中，从某寄存器开始连续存放。
    Range,
}

/// 解码调用类操作码（callargN / callthisN / callrange / callthisrange /
/// supercall 系列）。返回 `None` 表示不是调用。
pub fn decode_call(op: &str) -> Option<CallShape> {
    let base = op.split('.').next().unwrap_or(op);
    let base = base.strip_prefix("super").unwrap_or(base);
    let base = base.strip_prefix("call")?;
    if let Some(rest) = base.strip_prefix("thisrange") {
        if rest.is_empty() {
            return Some(CallShape { has_this: true, mode: CallMode::Range });
        }
    }
    if let Some(rest) = base.strip_prefix("range") {
        if rest.is_empty() {
            return Some(CallShape { has_this: false, mode: CallMode::Range });
        }
    }
    if let Some(rest) = base.strip_prefix("this") {
        if let Ok(n) = rest.parse::<usize>() {
            return Some(CallShape { has_this: true, mode: CallMode::Fixed(n) });
        }
    }
    // callargN / callN
    if let Some(rest) = base.strip_prefix("arg") {
        if let Ok(n) = rest.parse::<usize>() {
            return Some(CallShape { has_this: false, mode: CallMode::Fixed(n) });
        }
    }
    if let Ok(n) = base.parse::<usize>() {
        return Some(CallShape { has_this: false, mode: CallMode::Fixed(n) });
    }
    // callargs / callthisargs 旧式命名按区间处理
    if base == "args" {
        return Some(CallShape { has_this: false, mode: CallMode::Range });
    }
    if base == "thisargs" {
        return Some(CallShape { has_this: true, mode: CallMode::Range });
    }
    None
}

/// 方法返回语句种类。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RetKind {
    /// 返回累加器值。
    Value,
    /// 返回 undefined。
    Undefined,
    /// 返回对象（语义同 Value）。
    Object,
}

/// 指令分类结果：把操作码与操作数打包成语义动作。
#[derive(Debug, Clone)]
pub enum Kind {
    /// `mov vD, vS`。
    Move(u16, u16),
    /// `movi vD, imm`。
    MoveImm(u16, i64),
    /// 向累加器加载常量 / 寄存器。
    LoadAcc(Operand),
    /// `sta vD`：把累加器存入寄存器。
    StoreAcc(u16),
    /// 双寄存器算术 → 累加器。
    AluAcc2(AluOp),
    /// 就地复合赋值。
    AluInPlace(AluOp, u16, i64),
    /// 一元运算 → 累加器。
    AluUnary(AluOp),
    /// 比较赋值 → 累加器。
    CmpSet(Cmp),
    /// 跳转（含目标标签）。
    Jmp(Jump, String),
    /// 属性读：acc = acc.name（super 为真时 acc = super.name）。
    LoadProp { super_: bool },
    /// 属性写：v0.name = acc。
    StoreProp(String),
    /// 下标读：acc = acc[idx]，idx 为寄存器或立即数。
    IndexLoad(Operand),
    /// 读全局变量。
    LoadGlobal(String),
    /// 写全局变量。
    StoreGlobal(String),
    /// 读模块变量（字面量池索引）。
    LoadModule(i64),
    /// 写模块变量。
    StoreModule(i64),
    /// 方法调用。
    Call(CallShape),
    /// super 调用。
    SuperCall(CallShape),
    /// 创建对象实例。
    NewObj { class: Option<String>, argc: usize, first: Option<u16> },
    /// `{}` 字面量。
    EmptyObject,
    /// `[]` 字面量。
    EmptyArray,
    /// 从字面量池创建数组 / 对象（无法静态还原时降级）。
    BufferLiteral { array: bool, id: i64 },
    /// 定义类。
    DefineClass(String),
    /// 新建词法环境。
    LexNew(i64),
    /// 弹出词法环境。
    LexPop,
    /// 词法变量赋值 stlexvar d, s[, t]。
    LexStore(i64, i64),
    /// 词法变量读取 ldlexvar d, s。
    LexLoad(i64, i64),
    /// 抛出异常（累加器）。
    Throw,
    /// 返回。
    Ret(RetKind),
    /// async 相关标记指令。
    Async,
    /// await（累加器中的 promise）。
    Await,
    /// 空操作。
    Nop,
    /// 未知指令：保留原文降级输出。
    Other,
}

/// 把一条指令归类为语义动作。
pub fn classify(insn: &Insn) -> Kind {
    use Kind::*;
    let op = insn.opcode.as_str();
    let o = &insn.operands;

    // mov 家族
    if op == "mov" || op.starts_with("mov.") {
        if let (Some(d), Some(s)) = (o.first().and_then(|x| x.as_reg()), o.get(1).and_then(|x| x.as_reg())) {
            return Move(d, s);
        }
    }
    if op.starts_with("movi") {
        if let (Some(d), Some(i)) = (o.first().and_then(|x| x.as_reg()), o.get(1).and_then(|x| x.as_imm())) {
            return MoveImm(d, i);
        }
    }

    // 累加器加载 / 存储
    match op {
        // `lda vN` 加载寄存器；`lda.str` / `ldai` / `fldai` 的操作数本身就是字面量
        "lda" | "lda.str" | "ldai" | "fldai" => {
            return LoadAcc(o.first().cloned().unwrap_or(Operand::Undefined))
        }
        "ldanull" | "lda.null" => return LoadAcc(Operand::Null),
        "ldundefined" => return LoadAcc(Operand::Undefined),
        "ldtrue" => return LoadAcc(Operand::Bool(true)),
        "ldfalse" => return LoadAcc(Operand::Bool(false)),
        "ldnan" => return LoadAcc(Operand::Float(f64::NAN)),
        "ldinfinity" => return LoadAcc(Operand::Float(f64::INFINITY)),
        "sta" | "sta.64" | "sta.obj" => {
            if let Some(d) = o.first().and_then(|x| x.as_reg()) {
                return StoreAcc(d);
            }
        }
        _ => {}
    }

    // 算术
    if let Some((alu, form)) = decode_alu(op) {
        return match form {
            AluForm::Acc2 => AluAcc2(alu),
            AluForm::UnaryToAcc => AluUnary(alu),
            AluForm::InPlace => {
                if let (Some(r), Some(i)) = (o.first().and_then(|x| x.as_reg()), o.get(1).and_then(|x| x.as_imm())) {
                    AluInPlace(match alu {
                        AluOp::Add | AluOp::Sub => alu,
                        other => other,
                    }, r, i)
                } else {
                    Other
                }
            }
        };
    }

    // 比较 / 跳转
    if let Some(cmp) = decode_cmp_set(op) {
        return CmpSet(cmp);
    }
    if let Some(j) = decode_jump(op) {
        if let Some(t) = jump_target(insn) {
            return Jmp(j, t.to_string());
        }
        return Other;
    }

    // 属性访问
    if op.starts_with("ldobjbyname") || op.starts_with("getpropbyname") {
        return LoadProp { super_: false };
    }
    if op.starts_with("ldsuperbyname") {
        return LoadProp { super_: true };
    }
    if op.starts_with("stobjbyname") || op.starts_with("stownbyname") || op.starts_with("definefieldbyname") {
        if let Some(name) = o.iter().find_map(|x| x.as_str()) {
            return StoreProp(name.to_string());
        }
        return Other;
    }
    if op.starts_with("ldobjbyvalue") {
        if let Some(idx) = o.first() {
            return IndexLoad(idx.clone());
        }
    }
    if op.starts_with("ldobjbyindex") {
        if let Some(idx) = o.get(1).cloned().or_else(|| o.first().cloned()) {
            return IndexLoad(idx);
        }
    }

    // 全局 / 模块变量
    if op.starts_with("ldglobalvar") || op.starts_with("tryldglobalname") || op.starts_with("tryldglobalvalue")
        || op.starts_with("ldexternalobjvar") {
        if let Some(name) = o.iter().find_map(|x| x.as_str()) {
            return LoadGlobal(name.to_string());
        }
        return Other;
    }
    if op.starts_with("stglobalvar") || op.starts_with("stglobal") {
        if let Some(name) = o.iter().find_map(|x| x.as_str()) {
            return StoreGlobal(name.to_string());
        }
        return Other;
    }
    if op.starts_with("ldmodulevar") || op.starts_with("ldexternalmodulevar") || op.starts_with("tryldmodulevar")
        || op.starts_with("ldlocalmodulevar") {
        if let Some(id) = o.first().and_then(|x| x.as_imm()) {
            return LoadModule(id);
        }
        return Other;
    }
    if op.starts_with("stmodulevar") {
        if let Some(id) = o.first().and_then(|x| x.as_imm()) {
            return StoreModule(id);
        }
        return Other;
    }

    // 调用
    let is_super = op.starts_with("supercall");
    if let Some(shape) = decode_call(op) {
        return if is_super { SuperCall(shape) } else { Call(shape) };
    }

    // 对象 / 类构造
    if op.starts_with("newobjrange") {
        let class = class_name_of(o.first());
        let argc = o.get(1).and_then(|x| x.as_imm()).unwrap_or(0).max(0) as usize;
        let first = o.get(2).and_then(|x| x.as_reg());
        return NewObj { class, argc, first };
    }
    if op.starts_with("newobj") {
        let class = class_name_of(o.first());
        let argc = o.get(1).and_then(|x| x.as_imm()).unwrap_or(0).max(0) as usize;
        return NewObj { class, argc, first: None };
    }
    if op.starts_with("createemptyobject") {
        return EmptyObject;
    }
    if op.starts_with("createemptyarray") {
        return EmptyArray;
    }
    if op.starts_with("createarraywithbuffer") {
        if let Some(id) = o.first().and_then(|x| x.as_imm()) {
            return BufferLiteral { array: true, id };
        }
    }
    if op.starts_with("createobjectwithbuffer") {
        if let Some(id) = o.first().and_then(|x| x.as_imm()) {
            return BufferLiteral { array: false, id };
        }
    }
    if op.starts_with("defineclassbyname") || op.starts_with("defineclasswithbuffer") {
        let name = o.iter().find_map(|x| x.as_str()).unwrap_or("").to_string();
        return DefineClass(name);
    }

    // 词法环境
    if op.starts_with("newlexenvwithscope") || op.starts_with("newlexenv") {
        let n = o.first().and_then(|x| x.as_imm()).unwrap_or(0);
        return LexNew(n);
    }
    if op.starts_with("poplexenv") {
        return LexPop;
    }
    if op.starts_with("stlexvar") {
        let d = o.first().and_then(|x| x.as_imm()).unwrap_or(0);
        let s = o.get(1).and_then(|x| x.as_imm()).unwrap_or(0);
        return LexStore(d, s);
    }
    if op.starts_with("ldlexvar") {
        let d = o.first().and_then(|x| x.as_imm()).unwrap_or(0);
        let s = o.get(1).and_then(|x| x.as_imm()).unwrap_or(0);
        return LexLoad(d, s);
    }

    // 控制流终止
    if op == "throw" {
        return Throw;
    }
    if op == "return" || op == "return.64" {
        return Ret(RetKind::Value);
    }
    if op == "returnundefined" {
        return Ret(RetKind::Undefined);
    }
    if op == "returnobject" {
        return Ret(RetKind::Object);
    }

    // 异步
    if op.starts_with("asyncfunctionenter") || op.starts_with("asyncfunctionreject")
        || op.starts_with("asyncfunctionresolve") || op.starts_with("asyncgenerator") {
        return Async;
    }
    if op.starts_with("awaitresult") || op.starts_with("awaitshort") || op == "await" {
        return Await;
    }

    if op == "nop" {
        return Nop;
    }
    Other
}

/// 从操作数提取类名：优先字面量池名称表，其次 Id 文本。
fn class_name_of(op: Option<&Operand>) -> Option<String> {
    match op? {
        Operand::Id(s) => Some(s.clone()),
        _ => None,
    }
}

/// 标签 -> 行下标映射：`build_label_map` 统计每个标签指向的行位置。
///
/// 标签附着于其后的第一条指令；行下标以 [`parse_lines`] 输出的向量为准。
pub fn build_label_map(lines: &[Line]) -> HashMap<String, usize> {
    let mut map = HashMap::new();
    // pending 收集连续标签，全部指向下一个非标签行
    let mut pending: Vec<String> = vec![];
    for (i, line) in lines.iter().enumerate() {
        match line {
            Line::Label(name) => pending.push(name.clone()),
            Line::Insn(insn) => {
                if let Some(l) = &insn.label {
                    map.insert(l.clone(), i);
                }
                for p in pending.drain(..) {
                    map.insert(p, i);
                }
            }
            Line::Directive(_) => {}
        }
    }
    map
}

#[cfg(test)]
mod tests {
    use super::*;

    fn insn_of(line: &Line) -> &Insn {
        match line {
            Line::Insn(i) => i,
            other => panic!("期望指令，实际 {other:?}"),
        }
    }

    #[test]
    fn parses_labels_operands_and_comments() {
        let lines = parse_lines(&[
            "\tL0001: ldai 0x2a # 注释".into(),
            "\tlda.str \"brace } inside, ok\"".into(),
            "label_2:".into(),
            "\tmov v10, v3".into(),
            "\t.catchall {...}".into(),
        ]);
        assert_eq!(lines.len(), 5);

        let a = insn_of(&lines[0]);
        assert_eq!(a.label.as_deref(), Some("L0001"));
        assert_eq!(a.opcode, "ldai");
        assert_eq!(a.operands, vec![Operand::Imm(0x2a)]);

        let b = insn_of(&lines[1]);
        assert_eq!(b.operands, vec![Operand::Str("brace } inside, ok".into())]);

        assert!(matches!(&lines[2], Line::Label(n) if n == "label_2"));
        let c = insn_of(&lines[3]);
        assert_eq!(c.opcode, "mov");
        assert_eq!(c.operands, vec![Operand::Reg(10), Operand::Reg(3)]);
        assert!(matches!(&lines[4], Line::Directive(_)));
    }

    #[test]
    fn unescapes_strings() {
        assert_eq!(unescape(r"a\nb"), "a\nb");
        assert_eq!(unescape("a\\nb\\\"c\\\\d"), "a\nb\"c\\d");
        assert_eq!(unescape("A\\u4e2d"), "A中");
    }

    #[test]
    fn decodes_jumps_and_alu_shapes() {
        assert!(matches!(decode_jump("jmp"), Some(Jump::Always)));
        assert!(matches!(decode_jump("jeqz"), Some(Jump::Cond(Cmp::Eq, true))));
        assert!(matches!(decode_jump("jnez"), Some(Jump::Cond(Cmp::Ne, true))));
        assert!(matches!(decode_jump("jeq"), Some(Jump::Cond(Cmp::Eq, false))));

        assert!(matches!(decode_alu("add2"), Some((AluOp::Add, AluForm::Acc2))));
        assert!(matches!(decode_alu("sub2.64"), Some((AluOp::Sub, AluForm::Acc2))));
        assert!(matches!(decode_alu("addi"), Some((AluOp::Add, AluForm::InPlace))));
        assert!(matches!(decode_alu("inc"), Some((AluOp::Add, AluForm::InPlace))));
        assert!(matches!(decode_alu("dec"), Some((AluOp::Sub, AluForm::InPlace))));
        assert!(matches!(decode_alu("neg"), Some((AluOp::Neg, AluForm::UnaryToAcc))));
        assert!(decode_alu("lda.str").is_none());
    }

    #[test]
    fn decodes_calls() {
        let s = decode_call("callarg0").unwrap();
        assert!(!s.has_this && matches!(s.mode, CallMode::Fixed(0)));
        let s = decode_call("callthis2").unwrap();
        assert!(s.has_this && matches!(s.mode, CallMode::Fixed(2)));
        let s = decode_call("callrange").unwrap();
        assert!(!s.has_this && matches!(s.mode, CallMode::Range));
        let s = decode_call("supercallthisrange").unwrap();
        assert!(s.has_this && matches!(s.mode, CallMode::Range));
        assert!(decode_call("ldai").is_none());
    }

    #[test]
    fn classifies_common_insns() {
        let mk = |s: &str| parse_line(s);
        let l = mk("\tldobjbyname 0x1, \"log\"");
        match classify(insn_of(&l)) {
            Kind::LoadProp { super_: false } => {}
            k => panic!("{k:?}"),
        }
        let l = mk("\tstobjbyname 0x0, \"message\"");
        match classify(insn_of(&l)) {
            Kind::StoreProp(n) => assert_eq!(n, "message"),
            k => panic!("{k:?}"),
        }
        let l = mk("\tjeqz L0007");
        match classify(insn_of(&l)) {
            Kind::Jmp(Jump::Cond(Cmp::Eq, true), t) => assert_eq!(t, "L0007"),
            k => panic!("{k:?}"),
        }
        let l = mk("\treturnundefined");
        assert!(matches!(classify(insn_of(&l)), Kind::Ret(RetKind::Undefined)));
        let l = mk("\tunknownop123 v1");
        assert!(matches!(classify(insn_of(&l)), Kind::Other));
    }

    #[test]
    fn builds_label_map_with_stacked_labels() {
        let lines = parse_lines(&[
            "L0001:".into(),
            "L0002:".into(),
            "\tldai 0x1".into(),
            "\tjmp L0001".into(),
        ]);
        let m = build_label_map(&lines);
        assert_eq!(m["L0001"], 2);
        assert_eq!(m["L0002"], 2);
    }
}
