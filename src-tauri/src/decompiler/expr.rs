//! 表达式树与寄存器符号执行。
//!
//! [`Expr`] 表示还原过程中的符号值；[`render_expr`] 按 JS 运算符优先级
//! 输出 ArkTS 源码文本。[`Interp`] 维护寄存器 / 累加器的符号状态，
//! 并负责把「局部临时」延迟物化为 `let` 语句以保持输出整洁。

/// 二元运算符。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BinOp {
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
    Eq,
    Ne,
    StrictEq,
    StrictNe,
    Lt,
    Le,
    Gt,
    Ge,
}

impl BinOp {
    /// 运算符源码文本。
    pub fn text(&self) -> &'static str {
        match self {
            BinOp::Add => "+",
            BinOp::Sub => "-",
            BinOp::Mul => "*",
            BinOp::Div => "/",
            BinOp::Mod => "%",
            BinOp::BitAnd => "&",
            BinOp::BitOr => "|",
            BinOp::BitXor => "^",
            BinOp::Shl => "<<",
            BinOp::Shr => ">>",
            BinOp::UShr => ">>>",
            BinOp::Eq => "==",
            BinOp::Ne => "!=",
            BinOp::StrictEq => "===",
            BinOp::StrictNe => "!==",
            BinOp::Lt => "<",
            BinOp::Le => "<=",
            BinOp::Gt => ">",
            BinOp::Ge => ">=",
        }
    }

    /// 优先级（数值越大绑定越紧）。
    pub fn prec(&self) -> u8 {
        match self {
            BinOp::Eq | BinOp::Ne | BinOp::StrictEq | BinOp::StrictNe => 2,
            BinOp::Lt | BinOp::Le | BinOp::Gt | BinOp::Ge => 3,
            BinOp::Shl | BinOp::Shr | BinOp::UShr => 4,
            BinOp::Add | BinOp::Sub => 5,
            BinOp::Mul | BinOp::Div | BinOp::Mod => 6,
            BinOp::BitAnd => 7,
            BinOp::BitXor => 8,
            BinOp::BitOr => 9,
        }
    }
}

/// 一元运算符。
// Typeof 为后续迭代预留。
#[allow(dead_code)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UnOp {
    Not,
    Neg,
    Typeof,
}

impl UnOp {
    /// 前缀文本（Typeof 含尾部空格）。
    pub fn text(&self) -> &'static str {
        match self {
            UnOp::Not => "!",
            UnOp::Neg => "-",
            UnOp::Typeof => "typeof ",
        }
    }
}

/// 符号表达式。
// 部分变体（This / Ternary / Typeof / Raw）当前还原管线尚未构造，
// 为后续迭代（三元表达式、typeof、原样输出等）预留。
#[allow(dead_code)]
#[derive(Debug, Clone, PartialEq)]
pub enum Expr {
    /// 已命名的标识符（参数 / 局部 / 全局变量名）。
    Ident(String),
    /// `this`。
    This,
    Int(i64),
    Float(f64),
    Str(String),
    Bool(bool),
    Null,
    Undefined,
    /// 属性访问；`computed` 为真时使用方括号。
    Prop(Box<Expr>, String, bool),
    /// 下标访问 base[idx]。
    Index(Box<Expr>, Box<Expr>),
    /// 调用。callee 为 `super` 时渲染 `super(...)`。
    Call {
        callee: Box<Expr>,
        args: Vec<Expr>,
        optional: bool,
    },
    /// new 表达式。
    New {
        class: String,
        args: Vec<Expr>,
    },
    Bin {
        op: BinOp,
        l: Box<Expr>,
        r: Box<Expr>,
    },
    Un {
        op: UnOp,
        e: Box<Expr>,
    },
    /// instanceof 关系运算。
    Instanceof(Box<Expr>, Box<Expr>),
    Await(Box<Expr>),
    Ternary {
        c: Box<Expr>,
        t: Box<Expr>,
        f: Box<Expr>,
    },
    /// 对象字面量。
    Obj(Vec<(String, Expr)>),
    /// 数组字面量。
    Arr(Vec<Expr>),
    /// 类引用。
    ClassRef(String),
    /// 模块变量（字面量池未解析时带索引）。
    ModRef(i64, Option<String>),
    /// 无法静态还原的占位。
    Unknown(String),
    /// 原始汇编片段兜底。
    Raw(String),
}

/// 判断标识符是否为合法的 JS/TS 点号属性名。
fn is_plain_prop(name: &str) -> bool {
    !name.is_empty()
        && name.chars().enumerate().all(|(i, c)| {
            c == '$' || c == '_' || c.is_ascii_alphabetic() || (i > 0 && c.is_ascii_digit())
        })
}

/// 字符串字面量的 TS 转义。
pub fn escape_ts_string(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{{{:x}}}", c as u32)),
            c => out.push(c),
        }
    }
    out
}

/// 浮点数渲染（NaN / Infinity 特判）。
fn render_float(f: f64) -> String {
    if f.is_nan() {
        "NaN".into()
    } else if f.is_infinite() {
        if f > 0.0 {
            "Infinity".into()
        } else {
            "-Infinity".into()
        }
    } else if f.fract() == 0.0 && f.abs() < 1e15 {
        format!("{:.1}", f)
    } else {
        format!("{f}")
    }
}

/// 把表达式渲染为源码文本；`parent_prec` 为外层允许的最小优先级。
pub fn render_expr(e: &Expr, parent_prec: u8) -> String {
    let wrap = |s: String, prec: u8| {
        if prec < parent_prec {
            format!("({s})")
        } else {
            s
        }
    };
    match e {
        Expr::Ident(n) => n.clone(),
        Expr::This => "this".into(),
        Expr::Int(i) => i.to_string(),
        Expr::Float(f) => render_float(*f),
        Expr::Str(s) => format!("\"{}\"", escape_ts_string(s)),
        Expr::Bool(b) => b.to_string(),
        Expr::Null => "null".into(),
        Expr::Undefined => "undefined".into(),
        Expr::Prop(base, name, computed) => {
            let inner = render_expr(base, 11);
            if *computed || !is_plain_prop(name) {
                format!("{inner}[\"{}\"]", escape_ts_string(name))
            } else {
                format!("{inner}.{name}")
            }
        }
        Expr::Index(base, idx) => {
            let b = render_expr(base, 11);
            let i = render_expr(idx, 1);
            format!("{b}[{i}]")
        }
        Expr::Call {
            callee,
            args,
            optional,
        } => {
            let c = render_expr(callee, 11);
            let a: Vec<String> = args.iter().map(|x| render_expr(x, 1)).collect();
            let q = if *optional { "?." } else { "" };
            wrap(format!("{c}{q}({})", a.join(", ")), 11)
        }
        Expr::New { class, args } => {
            let a: Vec<String> = args.iter().map(|x| render_expr(x, 1)).collect();
            format!("new {class}({})", a.join(", "))
        }
        Expr::Bin { op, l, r } => {
            let p = op.prec();
            let text = format!(
                "{} {} {}",
                render_expr(l, p + 1),
                op.text(),
                render_expr(r, p + 1)
            );
            wrap(text, p)
        }
        Expr::Instanceof(l, r) => {
            // instanceof 与关系运算符同优先级
            let text = format!("{} instanceof {}", render_expr(l, 4), render_expr(r, 4));
            wrap(text, 3)
        }
        Expr::Un { op, e } => {
            // 一元运算作用于二元表达式需要括号
            let inner = render_expr(e, 10);
            wrap(format!("{}{}", op.text(), inner), 10)
        }
        Expr::Await(e) => {
            let inner = render_expr(e, 10);
            wrap(format!("await {inner}"), 10)
        }
        Expr::Ternary { c, t, f } => {
            let s = format!(
                "{} ? {} : {}",
                render_expr(c, 2),
                render_expr(t, 1),
                render_expr(f, 1)
            );
            wrap(s, 1)
        }
        Expr::Obj(fields) => {
            let parts: Vec<String> = fields
                .iter()
                .map(|(k, v)| {
                    if is_plain_prop(k) {
                        format!("{k}: {}", render_expr(v, 1))
                    } else {
                        format!("\"{}\": {}", escape_ts_string(k), render_expr(v, 1))
                    }
                })
                .collect();
            format!("{{ {} }}", parts.join(", "))
        }
        Expr::Arr(items) => {
            let parts: Vec<String> = items.iter().map(|x| render_expr(x, 1)).collect();
            format!("[{}]", parts.join(", "))
        }
        Expr::ClassRef(n) => n.clone(),
        Expr::ModRef(_id, Some(name)) => name.clone(),
        Expr::ModRef(id, None) => format!("__module_{}", id),
        Expr::Unknown(hint) => format!("undefined /* {hint} */"),
        Expr::Raw(text) => text.clone(),
    }
}

// ---------- 符号执行状态 ----------

use std::collections::HashMap;

/// 寄存器槽位：符号值 + 物化状态。
#[derive(Debug, Clone)]
pub struct Slot {
    /// 当前符号值。
    pub expr: Expr,
    /// 是否已被某条已生成语句引用过（引用后覆盖需物化命名）。
    pub used: bool,
    /// 物化后的变量名。
    pub name: Option<String>,
    /// 是否已经生成过 `let` 声明。
    pub declared: bool,
}

impl Slot {
    fn new(expr: Expr) -> Self {
        Slot {
            expr,
            used: false,
            name: None,
            declared: false,
        }
    }
}

/// 语句种类（由 emit 模块消费与渲染）。
#[derive(Debug, Clone)]
pub enum Stmt {
    /// 变量声明。
    Decl { name: String, init: Option<Expr> },
    /// 赋值。
    Assign { lhs: Expr, expr: Expr },
    /// 表达式语句。
    ExprStmt(Expr),
    /// 返回。
    Return(Option<Expr>),
    /// 抛出。
    Throw(Expr),
    /// 条件分支。
    If {
        cond: Expr,
        then: Vec<Stmt>,
        els: Option<Vec<Stmt>>,
    },
    /// 循环。
    While { cond: Expr, body: Vec<Stmt> },
    /// try/catch 区域（catch 参数名固定为 e）。
    TryCatch { body: Vec<Stmt>, catch: Vec<Stmt> },
    /// 注释行。
    Comment(String),
    /// 原始汇编块兜底。
    Raw(Vec<String>),
}

/// 符号解释器状态：寄存器 + 累加器 + 词法槽位。
#[derive(Debug, Clone)]
pub struct Interp {
    /// 参数寄存器（实例方法含 this）固定命名，不可省略物化。
    pub params: HashMap<u16, String>,
    pub regs: HashMap<u16, Slot>,
    /// 累加器（panda 指令的核心隐式操作数）。
    pub acc: Option<Expr>,
    /// 词法槽位 (d, s) -> 变量名。
    pub lex: HashMap<(i64, i64), String>,
    /// 待插入的声明（读取命名但未声明的槽位时先补声明）。
    pub pending_decls: Vec<Stmt>,
    /// 临时变量计数器。
    tmp_counter: usize,
    /// 已生成过声明的变量名（防止 merge 重复声明）。
    decls_emitted: std::collections::HashSet<String>,
}

impl Interp {
    /// 创建初始状态。
    pub fn new(params: HashMap<u16, String>) -> Self {
        Interp {
            params,
            regs: HashMap::new(),
            acc: None,
            lex: HashMap::new(),
            pending_decls: vec![],
            tmp_counter: 0,
            decls_emitted: std::collections::HashSet::new(),
        }
    }

    /// 分配下一个临时变量名。
    pub fn next_tmp(&mut self) -> String {
        self.tmp_counter += 1;
        format!("t{}", self.tmp_counter)
    }

    /// 读取寄存器（标记使用；参数直接返回名字）。
    pub fn read_reg(&mut self, r: u16) -> Expr {
        if let Some(p) = self.params.get(&r) {
            return Expr::Ident(p.clone());
        }
        let slot = self
            .regs
            .entry(r)
            .or_insert_with(|| Slot::new(Expr::Undefined));
        slot.used = true;
        if let (Some(name), false) = (&slot.name, slot.declared) {
            // 首次以命名形式读取：补一条声明，令后续覆盖成为普通赋值
            slot.declared = true;
            self.pending_decls.push(Stmt::Decl {
                name: name.clone(),
                init: Some(slot.expr.clone()),
            });
        }
        match &slot.name {
            Some(n) => Expr::Ident(n.clone()),
            None => slot.expr.clone(),
        }
    }

    /// 写入寄存器；返回是否需要外部处理（无需时语句已在内部排队）。
    ///
    /// - 未被引用过的匿名槽位：静默替换符号值；
    /// - 已命名 / 已引用的槽位：物化为声明或赋值语句。
    pub fn write_reg(&mut self, r: u16, expr: Expr) {
        if self.params.contains_key(&r) {
            let name = self.params[&r].clone();
            self.pending_decls.push(Stmt::Assign {
                lhs: Expr::Ident(name),
                expr,
            });
            return;
        }
        let needs_materialize = {
            let slot = self
                .regs
                .entry(r)
                .or_insert_with(|| Slot::new(Expr::Undefined));
            slot.used || slot.name.is_some()
        };
        if !needs_materialize {
            self.regs.insert(r, Slot::new(expr));
            return;
        }
        let already_named = self.regs.get(&r).and_then(|s| s.name.clone()).is_some();
        let name = if already_named {
            self.regs[&r].name.clone().unwrap()
        } else {
            let n = self.next_tmp();
            self.regs.get_mut(&r).unwrap().name = Some(n.clone());
            n
        };
        let declared = self.regs[&r].declared;
        self.pending_decls.push(if declared {
            Stmt::Assign {
                lhs: Expr::Ident(name),
                expr,
            }
        } else {
            self.regs.get_mut(&r).unwrap().declared = true;
            Stmt::Decl {
                name,
                init: Some(expr),
            }
        });
    }

    /// 取出累加器当前值并清空。
    pub fn take_acc(&mut self) -> Expr {
        self.acc.take().unwrap_or(Expr::Undefined)
    }

    /// 取出待插入声明。
    pub fn drain_pending(&mut self) -> Vec<Stmt> {
        std::mem::take(&mut self.pending_decls)
    }

    /// 词法槽位名（不存在则创建）。
    pub fn lex_name(&mut self, d: i64, s: i64) -> String {
        self.lex
            .entry((d, s))
            .or_insert_with(|| format!("lex{}_{}", d, s))
            .clone()
    }

    /// 复制一份分支前状态（共享临时计数器语义由调用方管理：
    /// 克隆体中的新命名会重复，因此合并时统一重命名）。
    pub fn snapshot(&self) -> Interp {
        self.clone()
    }

    /// 合并两个分支结束时的状态：不一致的寄存器降级为未知命名变量。
    pub fn merge(a: &mut Interp, b: &mut Interp) -> Interp {
        let mut merged = a.clone();
        let keys: Vec<u16> = merged
            .regs
            .keys()
            .copied()
            .chain(b.regs.keys().copied())
            .collect();
        for k in keys {
            let ea = a.regs.get(&k);
            let eb = b.regs.get(&k);
            match (ea, eb) {
                (Some(x), Some(y))
                    if x.expr == y.expr
                        && !x.used
                        && !y.used
                        && x.name.is_none()
                        && y.name.is_none() =>
                {
                    merged.regs.insert(k, x.clone());
                }
                _ => {
                    // 双侧都强制命名后取未知值，保证后续读取有定义
                    let name = format!("m{}", k);
                    let mk = || Slot {
                        expr: Expr::Undefined,
                        used: true,
                        name: Some(name.clone()),
                        declared: false,
                    };
                    a.regs.insert(k, mk());
                    b.regs.insert(k, mk());
                    merged.regs.insert(k, mk());
                    if merged.decls_emitted.insert(name.clone()) {
                        merged.pending_decls.push(Stmt::Decl { name, init: None });
                    }
                }
            }
        }
        merged.acc = if a.acc == b.acc { a.acc.clone() } else { None };
        merged.lex = a.lex.clone();
        // 取两侧较大的计数器，避免合并后命名冲突
        merged.tmp_counter = a.tmp_counter.max(b.tmp_counter);
        merged
    }
}
