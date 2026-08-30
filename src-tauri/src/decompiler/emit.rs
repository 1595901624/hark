//! 控制流还原与 ArkTS 代码生成。
//!
//! 处理流程：
//! 1. [`instr::parse_line`] 把方法体解析为指令序列；
//! 2. 预扫描标签与回边，标记循环头；
//! 3. [`walk`] 递归结构化控制流：识别 if / if-else 与 while 形态，
//!    其余指令线性解释为语句；无法识别的部分保留原始汇编块兜底；
//! 4. [`render_stmts`] 输出缩进良好的 ArkTS 文本。

use std::cell::Cell;
use std::collections::{HashMap, HashSet};

use super::expr::{render_expr, BinOp, Expr, Interp, Stmt, UnOp};
use super::instr::{self, AluOp, CallMode, Cmp, Jump, Kind, Line, Operand, RetKind};
use super::resolve::Names;
use super::sig::{self, Sig};
use crate::pa::{PaMethod, PaRecord};

/// 带原文的解析行（Raw 兜底输出需要原始文本）。
struct PLine {
    line: Line,
    raw: String,
}

/// `.catchall` 指令解析出的 try/catch 区域（行下标均指向指令位置）。
#[derive(Clone, Copy)]
struct TryCatchRegion {
    /// try 体起始。
    start: usize,
    /// try 体结束标签附着行（通常是一条 jmp，跳过不还原）。
    end_jmp: usize,
    /// catch 处理体起始。
    handler: usize,
    /// 汇合点（handler 结束后的公共代码）。
    join: usize,
}

/// 方法级不可变环境。
struct Env<'a> {
    lines: &'a [PLine],
    /// 标签名 -> 行下标。
    labels: &'a HashMap<String, usize>,
    /// 循环头行下标集合。
    loops: &'a HashSet<usize>,
    names: &'a Names,
    /// 是否检测到 async 指令。
    async_flag: &'a Cell<bool>,
    /// 隐式对象寄存器键（实例方法为 this；静态方法退化为临时槽）。
    this_key: u16,
    /// `.catchall` 区域列表。
    catches: &'a [TryCatchRegion],
}

/// 单步执行结果。
enum StepResult {
    Normal,
    Terminal,
}

/// 分支扫描结果。
enum IfScan {
    /// 已完成分支结构化，从该下标继续。
    Done(usize),
    /// 线性前缀已执行到该下标（遇循环头停止）。
    Prefix(usize),
    /// 范围内没有分支，调用方按单条指令步进。
    None,
}

// ---------- 公开入口 ----------

/// 还原单个方法体为 ArkTS 语句文本（不含函数头尾大括号）。
///
/// 实例方法自动把 v0 绑定为 `this`。
pub fn render_method_body(sig: &Sig, body: &[String], names: &Names) -> String {
    let plines: Vec<PLine> = body
        .iter()
        .filter_map(|raw| {
            let line = instr::parse_line(raw);
            match &line {
                Line::Directive(d) if d.is_empty() => None,
                other => Some(PLine {
                    line: other.clone(),
                    raw: raw.trim_end().to_string(),
                }),
            }
        })
        .collect();

    let bare: Vec<Line> = plines.iter().map(|p| p.line.clone()).collect();
    let labels = instr::build_label_map(&bare);

    // 回边检测：目标在当前位置之前的跳转把目标位置标记为循环头
    let mut loops: HashSet<usize> = HashSet::new();
    for (i, p) in plines.iter().enumerate() {
        if let Line::Insn(insn) = &p.line {
            if let Kind::Jmp(_, t) = instr::classify(insn) {
                if let Some(&tp) = labels.get(&t) {
                    if tp <= i {
                        loops.insert(tp);
                    }
                }
            }
        }
    }

    // 参数绑定：
    // - 方法体使用参数寄存器 aN 时按 a 组绑定（实例方法 a0 = this）；
    // - 否则退回旧约定（实例方法 v0 = this，其后 v1..vn）；
    // - 工具链合成的初始化方法不绑定 this 与参数
    //   （其寄存器是状态机槽位而非调用实参）。
    let uses_arg_regs = plines.iter().any(|p| match &p.line {
        Line::Insn(insn) => insn.operands.iter().any(|o| matches!(o, Operand::Arg(_))),
        _ => false,
    });
    let synthetic = sig.is_synthetic();
    let mut params: HashMap<u16, String> = HashMap::new();
    if !synthetic {
        if uses_arg_regs {
            let mut off: u16 = 0;
            if !sig.is_static {
                params.insert(instr::ARG_BASE, "this".to_string());
                off = 1;
            }
            for i in 0..sig.params.len() {
                params.insert(instr::ARG_BASE + off + i as u16, format!("p{}", i + 1));
            }
        } else {
            let mut off: u16 = 0;
            if !sig.is_static {
                params.insert(0, "this".to_string());
                off = 1;
            }
            for i in 0..sig.params.len() {
                params.insert(off + i as u16, format!("p{}", i + 1));
            }
        }
    }
    // 隐式对象寄存器（stobjbyname 等省略对象时的缺省）：实例方法为 this
    let this_key: u16 = if !sig.is_static && !synthetic && uses_arg_regs {
        instr::ARG_BASE
    } else if !sig.is_static && !synthetic {
        0
    } else {
        u16::MAX // 无语义 this：退化为普通临时寄存器 vMAX
    };

    let async_flag = Cell::new(sig.is_async_hint);
    let mut st = Interp::new(params);

    // `.catchall start, end, handler` 区域预扫描
    let mut catches: Vec<TryCatchRegion> = vec![];
    for p in plines.iter() {
        let raw = p.raw.trim();
        if !raw.starts_with(".catchall") {
            continue;
        }
        let rest = &raw[".catchall".len()..];
        let idents: Vec<&str> = rest
            .split(|c: char| c == ',' || c.is_whitespace())
            .filter(|s| !s.is_empty())
            .collect();
        if idents.len() < 3 {
            continue;
        }
        let (Some(&start), Some(&end_jmp), Some(&handler)) = (
            labels.get(idents[0]),
            labels.get(idents[1]),
            labels.get(idents[2]),
        ) else {
            continue;
        };
        // 两种形态：
        // - 常规：结束标签附着在一条 jmp 上（跳过它），其目标即汇合点，
        //   处理体位于 handler 标签与汇合点之间；
        // - 退化：handler 与结束为同一标签，处理体从结束标签直落到方法尾。
        let (join, handler_start) = match &plines[end_jmp].line {
            Line::Insn(insn) => match instr::classify(insn) {
                Kind::Jmp(Jump::Always, t) => {
                    let j = labels.get(&t).copied().unwrap_or(handler);
                    (j, handler)
                }
                _ => (plines.len(), end_jmp),
            },
            _ => (plines.len(), end_jmp),
        };
        catches.push(TryCatchRegion {
            start,
            end_jmp,
            handler: handler_start,
            join,
        });
    }

    let env = Env {
        lines: &plines,
        labels: &labels,
        loops: &loops,
        names,
        async_flag: &async_flag,
        this_key,
        catches: &catches,
    };

    let mut out: Vec<Stmt> = vec![];
    walk(&mut st, &mut out, 0, plines.len(), &env);
    flush_side_effects(&mut st, &mut out);
    for d in st.drain_pending() {
        out.push(d);
    }

    let mut text = String::new();
    render_stmts(&out, 1, &mut text);
    text
}

/// 还原整个 record（类）为 ArkTS 源码。
pub fn record_to_arkts(rec: &PaRecord, siblings: &[PaRecord], names: &Names) -> String {
    let mut out = String::new();
    if rec.is_external {
        out.push_str(&format!(
            "// 外部声明：{}（来自系统库或依赖，无方法体）\n",
            rec.display_name
        ));
        return out;
    }
    out.push_str(&format!(
        "// 该文件由 Hark 从方舟字节码还原生成，仅供参考\n// record: {}\n",
        rec.raw_name
    ));
    if let Some(sf) = &rec.source_file {
        out.push_str(&format!("// 来源文件: {sf}\n"));
    }

    if rec.display_name == "<global>" {
        return render_global_record(rec, names);
    }

    // import 声明：扫描方法体引用，按同单元 record 解析目标。
    let imports = collect_imports(rec, siblings, names);
    if !imports.is_empty() {
        out.push('\n');
        for line in imports {
            out.push_str(&line);
            out.push('\n');
        }
    }

    out.push('\n');
    out.push_str(&format!(
        "{}class {} {{\n",
        class_modifiers(rec.access_flags.as_deref()),
        safe_ident(&rec.display_name)
    ));

    // 字段：合并 .field 声明与方法体反推结果，按字段名去重
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    for field in &rec.fields {
        let (modifiers, name, ty) = parse_field(field);
        if !name.is_empty() {
            seen.insert(name.clone());
            out.push_str(&format!("    {modifiers}{name}: {ty}\n"));
        }
    }
    for (decl, ty) in collect_fields_from_methods(rec) {
        if seen.insert(decl.clone()) {
            out.push_str(&format!("    {decl}: {ty}\n"));
        }
    }
    if !rec.fields.is_empty() || !seen.is_empty() {
        out.push('\n');
    }

    // 方法：构造函数优先，其余保持原顺序
    let mut ordered: Vec<&PaMethod> = rec.methods.iter().collect();
    ordered.sort_by_key(|m| (!sig::parse(&m.signature).is_ctor(), method_order(rec, m)));
    for m in ordered {
        let s = sig::parse(&m.signature);
        let body = render_method_body(&s, &m.body, names);
        let kw = if sig::is_method_async_hint(&m.body) || s.is_async_hint {
            "async "
        } else {
            ""
        };
        let stat = if s.is_static { "static " } else { "" };
        out.push_str(&format!("    {stat}{kw}{} {{\n", method_head(&s)));
        // 方法体文本自带一级缩进，叠加类成员层级
        for line in body.lines() {
            if line.is_empty() {
                out.push('\n');
            } else {
                out.push_str("    ");
                out.push_str(line);
                out.push('\n');
            }
        }
        out.push_str("    }\n\n");
    }
    out.push_str("}\n");
    out
}

/// `<global>` record 的还原：顶层函数、全局变量与模块入口语句。
fn render_global_record(rec: &PaRecord, names: &Names) -> String {
    let mut out = String::new();
    out.push_str("// 全局作用域（无归属 record 的函数与变量）\n\n");
    for f in &rec.fields {
        let (_, name, ty) = parse_field(f);
        if !name.is_empty() {
            out.push_str(&format!("let {name}: {ty};\n"));
        }
    }
    for m in &rec.methods {
        let s = sig::parse(&m.signature);
        if s.is_module_main() {
            out.push_str("// ---- 模块入口 ----\n");
            out.push_str(&render_method_body(&s, &m.body, names));
            out.push('\n');
            continue;
        }
        let kw = if sig::is_method_async_hint(&m.body) || s.is_async_hint {
            "async "
        } else {
            ""
        };
        out.push_str(&format!("export {kw}function {} {{\n", function_head(&s)));
        out.push_str(&render_method_body(&s, &m.body, names));
        out.push_str("}\n\n");
    }
    out
}

/// 扫描方法体，收集可推导为 import 的引用名。
///
/// 候选来源：模块变量读写（字面量池索引）、类定义、`newobj` 类名、
/// `instanceof` 等。能匹配到同单元其他 record 展示名末段时生成
/// `import { Name } from '<display_name>';`，否则生成注释式占位。
fn collect_imports(rec: &PaRecord, siblings: &[PaRecord], names: &Names) -> Vec<String> {
    use instr::{classify, parse_line, Kind, Line};

    // 同单元其他 record 的展示名末段 -> 完整展示名，用于解析 import 来源
    let mut sibling_map: HashMap<String, String> = HashMap::new();
    for s in siblings {
        if s.display_name == rec.display_name || s.display_name == "<global>" {
            continue;
        }
        // 取展示名最后一段作为短名（如 foo.Helper -> Helper），再清洗为合法标识符
        let last = s.display_name.rsplit('.').next().unwrap_or(&s.display_name);
        let short = safe_ident(last);
        if short.is_empty() {
            continue;
        }
        sibling_map.entry(short).or_insert(s.display_name.clone());
    }

    // 候选名 -> 来源标记；已匹配同单元的与未解析的分开
    let mut resolved: Vec<(String, String)> = Vec::new();
    let mut unresolved: Vec<String> = Vec::new();
    let mut pushed: std::collections::HashSet<String> = std::collections::HashSet::new();

    let push = |name: &str, resolved_list: &mut Vec<(String, String)>, unresolved_list: &mut Vec<String>, pushed: &mut std::collections::HashSet<String>| {
        let key = name.to_string();
        if !pushed.insert(key.clone()) {
            return;
        }
        if let Some(full) = sibling_map.get(name) {
            resolved_list.push((name.to_string(), full.clone()));
        } else {
            unresolved_list.push(name.to_string());
        }
    };

    for m in &rec.methods {
        for raw in &m.body {
            let line = parse_line(raw);
            let insn = match line {
                Line::Insn(i) => i,
                _ => continue,
            };
            match classify(&insn) {
                Kind::LoadModule(id) | Kind::StoreModule(id) => {
                    if let Some(n) = names.get(id) {
                        push(n, &mut resolved, &mut unresolved, &mut pushed);
                    }
                }
                Kind::LoadGlobal(n) | Kind::StoreGlobal(n) => {
                    push(&n, &mut resolved, &mut unresolved, &mut pushed);
                }
                Kind::NewObj { class: Some(c), .. } => {
                    if !c.is_empty() {
                        push(&c, &mut resolved, &mut unresolved, &mut pushed);
                    }
                }
                Kind::DefineClass(n) => {
                    if !n.is_empty() {
                        push(&n, &mut resolved, &mut unresolved, &mut pushed);
                    }
                }
                _ => {}
            }
        }
    }

    let mut out = Vec::new();
    for (name, full) in resolved {
        out.push(format!("import {{ {name} }} from '{full}';"));
    }
    for name in unresolved {
        out.push(format!("// import {{ {name} }} from '...';"));
    }
    out
}

/// 扫描方法体，反推类属性字段。
///
/// `.field` 行缺失时，从 `stobjbyname` / `definefieldbyname` /
/// `stprivateproperty` 等属性写指令提取字段名。返回 `(修饰符+名, 类型)`；
/// 类型统一为 `any`（`.pa` 无类型信息）。
fn collect_fields_from_methods(rec: &PaRecord) -> Vec<(String, &'static str)> {
    use instr::{classify, parse_line, Kind, Line};

    let mut out: Vec<(String, &'static str)> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    for m in &rec.methods {
        for raw in &m.body {
            let line = parse_line(raw);
            let insn = match line {
                Line::Insn(i) => i,
                _ => continue,
            };
            match classify(&insn) {
                Kind::StoreProp(n) | Kind::DefineProperty(n) => {
                    if !n.is_empty() && seen.insert(n.clone()) {
                        out.push((format!("public {n}"), "any"));
                    }
                }
                Kind::StorePrivateProp(n) => {
                    if !n.is_empty() && seen.insert(n.clone()) {
                        out.push((format!("private {n}"), "any"));
                    }
                }
                _ => {}
            }
        }
    }
    out
}

/// 还原单个方法为独立函数文本（方法节点视图）。
pub fn method_to_arkts(
    owner: &str,
    method_name: &str,
    signature: &str,
    body: &[String],
    names: &Names,
) -> String {
    let s = sig::parse(signature);
    let owner_label = if owner.is_empty() || owner == "<global>" {
        format!("全局函数 {method_name}")
    } else {
        format!("{}.{}", safe_ident(owner), method_name)
    };
    let kw = if sig::is_method_async_hint(body) || s.is_async_hint {
        "async "
    } else {
        ""
    };
    let mut out = String::new();
    out.push_str(&format!("// {owner_label} 的字节码还原\n"));
    out.push_str(&format!("export {kw}function {} {{\n", function_head(&s)));
    out.push_str(&render_method_body(&s, body, names));
    out.push_str("}\n");
    out
}

// ---------- 方法头 ----------

/// 类成员形式的方法头：`ctor(p1: any)` / `foo(p1: any): void`。
fn method_head(s: &Sig) -> String {
    // 合成方法（模块入口等）的寄存器不是调用实参，头都不带参数
    let args: Vec<String> = if s.is_synthetic() {
        vec![]
    } else {
        s.params
            .iter()
            .enumerate()
            .map(|(i, t)| format!("p{}: {}", i + 1, Sig::ts_type(t)))
            .collect()
    };
    if s.is_ctor() {
        return format!("constructor({})", args.join(", "));
    }
    format!(
        "{}({}): {}",
        safe_member_name(&s.name),
        args.join(", "),
        Sig::ts_type(&s.ret)
    )
}

/// 顶层函数形式的函数头：`main(p1: any): void`。
fn function_head(s: &Sig) -> String {
    let args: Vec<String> = if s.is_synthetic() {
        vec![]
    } else {
        s.params
            .iter()
            .enumerate()
            .map(|(i, t)| format!("p{}: {}", i + 1, Sig::ts_type(t)))
            .collect()
    };
    format!(
        "{}({}): {}",
        safe_ident(&s.name),
        args.join(", "),
        Sig::ts_type(&s.ret)
    )
}

// ---------- 控制流结构化 ----------

/// 递归解释 `[lo, hi)` 区间，把语句追加到 `out`。
fn walk(st: &mut Interp, out: &mut Vec<Stmt>, lo: usize, hi: usize, env: &Env) {
    let mut i = lo;
    while i < hi {
        // try/catch 区域优先
        if let Some(next) = try_catch_at(st, out, i, hi, env) {
            i = next;
            continue;
        }
        if env.loops.contains(&i) {
            if let Some(next) = try_while(st, out, i, hi, env) {
                i = next;
                continue;
            }
        }
        match try_if(st, out, i, hi, env) {
            IfScan::Done(next) => {
                i = next;
                continue;
            }
            IfScan::Prefix(k) => {
                i = k;
                continue;
            }
            IfScan::None => match step(st, out, i, env) {
                StepResult::Normal => i += 1,
                StepResult::Terminal => {
                    // async 状态机的 return 之后代码仍可达（不同恢复模式），
                    // 继续线性执行而不是按不可达丢弃
                    if env.async_flag.get() {
                        i += 1;
                        continue;
                    }
                    if resolve_pos(env, i + 1).is_some_and(|p| p < hi) {
                        if let Some(b) = unreachable_block(env, i + 1, hi) {
                            out.push(b);
                        }
                    }
                    break;
                }
            },
        }
    }
}

/// 判断表达式是否具有副作用（丢弃累加器时需要保留为语句）。
fn is_side_effectful(e: &Expr) -> bool {
    matches!(
        e,
        Expr::Call { .. } | Expr::New { .. } | Expr::Await(_) | Expr::Raw(_) | Expr::Unknown(_)
    )
}

/// 把累加器中残留的副作用表达式冲刷为独立语句。
fn flush_side_effects(st: &mut Interp, out: &mut Vec<Stmt>) {
    if let Some(e) = st.acc.take() {
        if is_side_effectful(&e) {
            out.push(Stmt::ExprStmt(e));
        }
    }
}

/// 尝试在 `[lo, hi)` 内识别并生成 if / if-else 结构。
fn try_if(st: &mut Interp, out: &mut Vec<Stmt>, lo: usize, hi: usize, env: &Env) -> IfScan {
    // 找到第一个「感兴趣」的位置：分支指令或后续循环头
    let mut k = lo;
    let branch_insn = loop {
        if k >= hi {
            return IfScan::None;
        }
        if k > lo && env.loops.contains(&k) {
            return IfScan::Prefix(k);
        }
        if let Line::Insn(insn) = &env.lines[k].line {
            let kind = instr::classify(insn);
            if matches!(kind, Kind::Jmp(..)) {
                break insn.clone();
            }
        }
        k += 1;
    };
    let branch = instr::classify(&branch_insn);

    // 先线性执行前缀 [lo, k)
    let mut i = lo;
    while i < k {
        match step(st, out, i, env) {
            StepResult::Normal => i += 1,
            StepResult::Terminal => {
                if env.async_flag.get() {
                    i += 1;
                    continue;
                }
                if resolve_pos(env, i + 1).is_some_and(|p| p < hi) {
                    if let Some(b) = unreachable_block(env, i + 1, hi) {
                        out.push(b);
                    }
                }
                return IfScan::Done(hi);
            }
        }
    }

    let (jump, target_name) = match &branch {
        Kind::Jmp(j, t) => (j.clone(), t.clone()),
        _ => return IfScan::Done(k + 1),
    };
    let target_pos = match env.labels.get(&target_name) {
        Some(&p) => p,
        None => return IfScan::Done(k + 1),
    };

    match jump {
        Jump::Always => {
            if target_pos <= k {
                // 未被循环结构吸收的向后跳转：视为当前区间结束
                IfScan::Done(hi)
            } else if target_pos == k + 1 {
                IfScan::Done(k + 1)
            } else {
                out.push(Stmt::Comment(format!("跳转至 {target_name}")));
                IfScan::Done(k + 1)
            }
        }
        Jump::Cond(..) => {
            if target_pos <= k {
                out.push(Stmt::Comment(format!("条件跳转至 {target_name}（回边）")));
                return IfScan::Done(k + 1);
            }
            let t = target_pos.min(hi);
            let pred = build_pred_from_branch(st, &branch, &branch_insn);
            let guard = invert_pred(pred);

            // else 分隔 jmp：位于 (k, t)，且其后第一条指令就是条件跳转的目标
            // （中间可能隔着独立成行的标签，需要穿透解析位置）
            let mut sep: Option<usize> = None;
            for x in (k + 1)..t {
                if let Line::Insn(insn) = &env.lines[x].line {
                    if let Kind::Jmp(Jump::Always, _) = instr::classify(insn) {
                        if resolve_pos(env, x + 1) == Some(t) {
                            sep = Some(x);
                            break;
                        }
                    }
                }
            }

            let pre = st.snapshot();
            let then_end = sep.unwrap_or(t);
            let mut then_st = pre.clone();
            let mut then_out: Vec<Stmt> = vec![];
            walk(&mut then_st, &mut then_out, k + 1, then_end, env);
            flush_side_effects(&mut then_st, &mut then_out);

            let mut else_st = pre.clone();
            let mut else_out: Vec<Stmt> = vec![];
            let mut resume = t;
            let mut has_else = false;
            if let Some(j) = sep {
                let end_name = match &env.lines[j].line {
                    Line::Insn(insn) => match instr::classify(insn) {
                        Kind::Jmp(Jump::Always, e) => e,
                        _ => String::new(),
                    },
                    _ => String::new(),
                };
                // 结束标签解析后的位置就是汇合点代码本身
                let e = env.labels.get(&end_name).copied().unwrap_or(t).min(hi);
                walk(&mut else_st, &mut else_out, t, e.max(t), env);
                flush_side_effects(&mut else_st, &mut else_out);
                resume = e.max(t);
                has_else = true;
            }

            let mut merged = Interp::merge(&mut then_st, &mut else_st);
            for d in merged.drain_pending() {
                out.push(d);
            }
            *st = merged;

            out.push(Stmt::If {
                cond: guard,
                then: then_out,
                els: if has_else { Some(else_out) } else { None },
            });
            IfScan::Done(resume)
        }
    }
}

/// 若 `i` 是某个 `.catchall` 区域的起始，生成 try/catch 结构。
fn try_catch_at(
    st: &mut Interp,
    out: &mut Vec<Stmt>,
    i: usize,
    hi: usize,
    env: &Env,
) -> Option<usize> {
    let region = *env.catches.iter().find(|t| t.start == i)?;
    if region.end_jmp > hi || region.join > hi {
        return None;
    }

    // 子作用域排除当前区域，避免体/处理体重入同一 try
    let inner: Vec<TryCatchRegion> = env
        .catches
        .iter()
        .copied()
        .filter(|t| t.start != region.start)
        .collect();
    let body_env = Env {
        lines: env.lines,
        labels: env.labels,
        loops: env.loops,
        names: env.names,
        async_flag: env.async_flag,
        this_key: env.this_key,
        catches: &inner,
    };
    let catch_env = Env {
        catches: &inner,
        ..body_env
    };

    let pre = st.snapshot();
    let mut body_st = pre.clone();
    let mut body_out: Vec<Stmt> = vec![];
    walk(&mut body_st, &mut body_out, i, region.end_jmp, &body_env);

    let mut catch_st = pre.clone();
    let mut catch_out: Vec<Stmt> = vec![];
    // 异常对象注入累加器：处理体开头的 sta 会把它存入局部
    catch_st.acc = Some(Expr::Ident("e".into()));
    walk(
        &mut catch_st,
        &mut catch_out,
        region.handler,
        region.join.max(region.handler),
        &catch_env,
    );
    flush_side_effects(&mut catch_st, &mut catch_out);

    let mut merged = Interp::merge(&mut body_st, &mut catch_st);
    for d in merged.drain_pending() {
        out.push(d);
    }
    *st = merged;

    out.push(Stmt::TryCatch {
        body: body_out,
        catch: catch_out,
    });
    Some(region.join)
}

/// 尝试在循环头 `h` 处识别 while 循环。成功返回循环之后的下标。
fn try_while(
    st: &mut Interp,
    out: &mut Vec<Stmt>,
    h: usize,
    hi: usize,
    env: &Env,
) -> Option<usize> {
    // 找到跳回循环头的闭合 jmp
    let mut close: Option<usize> = None;
    for x in (h + 1)..hi {
        if let Line::Insn(insn) = &env.lines[x].line {
            if let Kind::Jmp(Jump::Always, t) = instr::classify(insn) {
                if env.labels.get(&t).copied() == Some(h) {
                    close = Some(x);
                    break;
                }
            }
        }
    }
    let j = close?;

    // 找到守卫条件分支（第一个跳出循环区的条件跳转）
    let mut guard: Option<(usize, String)> = None;
    for x in h..j {
        if let Line::Insn(insn) = &env.lines[x].line {
            if let Kind::Jmp(Jump::Cond(..), t) = instr::classify(insn) {
                let tp = env.labels.get(&t).copied().unwrap_or(usize::MAX);
                if tp > j || tp < h {
                    guard = Some((x, t));
                    break;
                }
            }
        }
    }

    let mut g = st.snapshot();
    let mut body_stmts: Vec<Stmt> = vec![];

    let mut guard_cb: Option<usize> = None;
    let cond = match guard {
        Some((cb, t_name)) => {
            // 守卫区线性执行（语义上属于循环体头部）
            for x in h..cb {
                match step(&mut g, &mut body_stmts, x, env) {
                    StepResult::Normal => {}
                    StepResult::Terminal => return None,
                }
            }
            let pred_line = env.lines[cb].line.clone();
            let p = build_pred_from_line(&mut g, &pred_line);
            let tp = env.labels.get(&t_name).copied().unwrap_or(usize::MAX);
            guard_cb = Some(cb);
            // 出口跳转取反即为继续条件；跳向循环内部的跳转本身就是继续条件
            if tp > j || tp < h {
                invert_pred(p)
            } else {
                p
            }
        }
        None => Expr::Bool(true),
    };

    let body_start = guard_cb.map(|cb| cb + 1).unwrap_or(h);
    let mut body_st = g.clone();
    walk(&mut body_st, &mut body_stmts, body_start, j, env);
    flush_side_effects(&mut body_st, &mut body_stmts);

    let mut post = Interp::merge(&mut g, &mut body_st);
    for d in post.drain_pending() {
        out.push(d);
    }
    *st = post;
    out.push(Stmt::While {
        cond,
        body: body_stmts,
    });
    Some((j + 1).min(hi))
}

/// 生成「不可达指令」兜底块；剩余仅为 return / 标签时无需输出。
fn unreachable_block(env: &Env, lo: usize, hi: usize) -> Option<Stmt> {
    let mut raws: Vec<String> = vec![];
    for p in env.lines.iter().take(hi).skip(lo) {
        match &p.line {
            Line::Label(_) | Line::Directive(_) => continue,
            Line::Insn(insn) => {
                if matches!(instr::classify(insn), Kind::Ret(_)) {
                    continue;
                }
                raws.push(p.raw.clone());
            }
        }
    }
    if raws.is_empty() {
        return None;
    }
    let mut all = vec!["未还原的后续指令（不可达）:".to_string()];
    all.extend(raws);
    Some(Stmt::Raw(all))
}

/// 解析行下标：跳过独立标签 / 伪指令行，返回其后第一条指令的下标。
fn resolve_pos(env: &Env, idx: usize) -> Option<usize> {
    let mut i = idx;
    while i < env.lines.len() {
        match &env.lines[i].line {
            Line::Label(_) | Line::Directive(_) => i += 1,
            Line::Insn(_) => return Some(i),
        }
    }
    None
}

// ---------- 谓词构建 ----------

/// 由分支指令种类构建「成立谓词」。
fn build_pred_from_branch(st: &mut Interp, branch: &Kind, insn: &instr::Insn) -> Expr {
    if let Kind::Jmp(Jump::Cond(cmp, zero), _) = branch {
        if *zero {
            let x = st.take_acc();
            return match cmp {
                Cmp::Eq => Expr::Un {
                    op: UnOp::Not,
                    e: Box::new(x),
                },
                _ => x,
            };
        }
        // 非零比较：累加器为左值，寄存器 / 字面量操作数为右值
        let x = st.take_acc();
        let y = match insn.operands.first() {
            Some(Operand::Reg(r)) => st.read_reg(*r),
            Some(op) => literal_expr(op),
            None => Expr::Undefined,
        };
        return Expr::Bin {
            op: cmp_op(*cmp),
            l: Box::new(x),
            r: Box::new(y),
        };
    }
    Expr::Bool(true)
}

/// 兼容接口：从解析行构建谓词。
fn build_pred_from_line(st: &mut Interp, line: &Line) -> Expr {
    match line {
        Line::Insn(i) => {
            let kind = instr::classify(i);
            build_pred_from_branch(st, &kind, i)
        }
        _ => Expr::Bool(true),
    }
}

/// 字面量操作数到表达式的纯转换（不推进寄存器状态）。
fn literal_expr(op: &Operand) -> Expr {
    match op {
        Operand::Imm(i) => Expr::Int(*i),
        Operand::Float(f) => Expr::Float(*f),
        Operand::Bool(b) => Expr::Bool(*b),
        Operand::Str(s) => Expr::Str(s.clone()),
        Operand::Null => Expr::Null,
        _ => Expr::Undefined,
    }
}

/// 取反谓词（双重否定化简）。
fn invert_pred(e: Expr) -> Expr {
    match e {
        Expr::Un {
            op: UnOp::Not,
            e: inner,
        } => *inner,
        other => Expr::Un {
            op: UnOp::Not,
            e: Box::new(other),
        },
    }
}

/// Cmp 到二元运算符的映射。
fn cmp_op(c: Cmp) -> BinOp {
    match c {
        Cmp::Eq => BinOp::Eq,
        Cmp::Ne => BinOp::Ne,
        Cmp::Lt => BinOp::Lt,
        Cmp::Le => BinOp::Le,
        Cmp::Gt => BinOp::Gt,
        Cmp::Ge => BinOp::Ge,
        Cmp::StrictEq => BinOp::StrictEq,
        Cmp::StrictNe => BinOp::StrictNe,
    }
}

/// AluOp 到二元运算符的映射（一元运算不应到达这里）。
fn bin_of(op: AluOp, l: Expr, r: Expr) -> Expr {
    let b = match op {
        AluOp::Add => BinOp::Add,
        AluOp::Sub => BinOp::Sub,
        AluOp::Mul => BinOp::Mul,
        AluOp::Div => BinOp::Div,
        AluOp::Mod => BinOp::Mod,
        AluOp::BitAnd => BinOp::BitAnd,
        AluOp::BitOr => BinOp::BitOr,
        AluOp::BitXor => BinOp::BitXor,
        AluOp::Shl => BinOp::Shl,
        AluOp::Shr => BinOp::Shr,
        AluOp::UShr => BinOp::UShr,
        _ => BinOp::Add,
    };
    Expr::Bin {
        op: b,
        l: Box::new(l),
        r: Box::new(r),
    }
}

// ---------- 单条指令解释 ----------

/// 解释一条指令，把产生的语句追加到 `out`。
fn step(st: &mut Interp, out: &mut Vec<Stmt>, idx: usize, env: &Env) -> StepResult {
    let pline = &env.lines[idx];
    let insn = match &pline.line {
        Line::Insn(i) => i.clone(),
        Line::Label(l) => {
            out.push(Stmt::Comment(format!("{l}:")));
            return StepResult::Normal;
        }
        Line::Directive(d) => {
            out.push(Stmt::Comment(d.clone()));
            return StepResult::Normal;
        }
    };

    let is_super_call = matches!(instr::classify(&insn), Kind::SuperCall(_));
    let kind = instr::classify(&insn);

    macro_rules! flush {
        () => {
            for d in st.drain_pending() {
                out.push(d);
            }
        };
    }

    match kind {
        Kind::Move(d, s) => {
            let e = st.read_reg(s);
            st.write_reg(d, e);
        }
        Kind::MoveImm(d, i) => {
            st.write_reg(d, Expr::Int(i));
        }
        Kind::LoadAcc(op) => {
            // 常量覆盖未消费的副作用调用时，先把调用保留为语句
            if let Some(old) = &st.acc {
                if matches!(
                    op,
                    Operand::Imm(_)
                        | Operand::Float(_)
                        | Operand::Bool(_)
                        | Operand::Str(_)
                        | Operand::Null
                        | Operand::Undefined
                ) && is_side_effectful(old)
                {
                    let e = st.take_acc();
                    flush!();
                    out.push(Stmt::ExprStmt(e));
                }
            }
            st.acc = Some(match op {
                Operand::Reg(r) => st.read_reg(r),
                other => literal_expr(&other),
            });
        }
        Kind::StoreAcc(r) => {
            // panda 的 sta 不清空累加器（后续 TDZ 守卫等仍依赖它）
            let e = st.acc.clone().unwrap_or(Expr::Undefined);
            st.write_reg(r, e);
        }
        Kind::AluAcc2(op) => {
            let b = operand_expr(st, insn.operands.get(1));
            let a = operand_expr(st, insn.operands.first());
            st.acc = Some(bin_of(op, a, b));
        }
        Kind::AluInPlace(op, r, i) => {
            let cur = st.read_reg(r);
            let e = bin_of(op, cur, Expr::Int(i));
            st.write_reg(r, e);
        }
        Kind::AluUnary(op) => {
            let e = operand_expr(st, insn.operands.first());
            let u = match op {
                AluOp::Neg => Expr::Un {
                    op: UnOp::Neg,
                    e: Box::new(e),
                },
                _ => Expr::Un {
                    op: UnOp::Not,
                    e: Box::new(e),
                },
            };
            st.acc = Some(u);
        }
        Kind::CmpSet(cmp) => {
            let r = operand_expr(st, insn.operands.get(1));
            let l = operand_expr(st, insn.operands.first());
            st.acc = Some(Expr::Bin {
                op: cmp_op(cmp),
                l: Box::new(l),
                r: Box::new(r),
            });
        }
        Kind::Jmp(..) => {
            // 分支统一由 walk / try_if 结构化处理；走到这里的属于未匹配形态
            out.push(Stmt::Comment(pline.raw.clone()));
        }
        Kind::LoadProp { super_ } => {
            let name = insn
                .operands
                .iter()
                .find_map(|o| o.as_str())
                .unwrap_or("<unknown>")
                .to_string();
            let base = if super_ {
                Expr::Ident("super".into())
            } else {
                st.take_acc()
            };
            st.acc = Some(Expr::Prop(Box::new(base), name, false));
        }
        Kind::StoreProp(name) => {
            // 该版本 ark_disasm 显式输出对象寄存器（最后一个 Reg 操作数），
            // 旧版省略时退回隐式对象寄存器
            let obj_key = insn
                .operands
                .iter()
                .filter_map(|o| o.reg_key())
                .last()
                .unwrap_or(env.this_key);
            let obj = if obj_key == u16::MAX {
                Expr::Undefined
            } else {
                st.read_reg(obj_key)
            };
            let val = st.take_acc();
            flush!();
            out.push(Stmt::Assign {
                lhs: Expr::Prop(Box::new(obj), name, false),
                expr: val,
            });
            return StepResult::Normal;
        }
        Kind::StoreSuperProp(name) => {
            let val = st.take_acc();
            flush!();
            out.push(Stmt::Assign {
                lhs: Expr::Prop(Box::new(Expr::Ident("super".into())), name, false),
                expr: val,
            });
            return StepResult::Normal;
        }
        Kind::IndexStore(idx_op) => {
            let obj = st.read_reg(0);
            let idx = match idx_op {
                Operand::Reg(r) => st.read_reg(r),
                other => literal_expr(&other),
            };
            let val = st.take_acc();
            flush!();
            out.push(Stmt::Assign {
                lhs: Expr::Index(Box::new(obj), Box::new(idx)),
                expr: val,
            });
            return StepResult::Normal;
        }
        Kind::IndexLoad(idx_op) => {
            let base = st.take_acc();
            let idx = match idx_op {
                Operand::Reg(r) => st.read_reg(r),
                other => literal_expr(&other),
            };
            st.acc = Some(Expr::Index(Box::new(base), Box::new(idx)));
        }
        // 私有属性读：对象为操作数中的寄存器（缺省隐式对象寄存器）
        Kind::LoadPrivateProp => {
            let name = insn
                .operands
                .iter()
                .find_map(|o| o.as_str())
                .unwrap_or("<unknown>")
                .to_string();
            let obj = insn
                .operands
                .iter()
                .find_map(|o| o.reg_key())
                .unwrap_or(env.this_key);
            let obj = if obj == u16::MAX {
                Expr::Undefined
            } else {
                st.read_reg(obj)
            };
            st.acc = Some(Expr::Prop(Box::new(obj), name, false));
        }
        Kind::StorePrivateProp(name) => {
            let obj_key = insn
                .operands
                .iter()
                .find_map(|o| o.reg_key())
                .unwrap_or(env.this_key);
            let obj = if obj_key == u16::MAX {
                Expr::Undefined
            } else {
                st.read_reg(obj_key)
            };
            let val = st.take_acc();
            flush!();
            out.push(Stmt::Assign {
                lhs: Expr::Prop(Box::new(obj), name, false),
                expr: val,
            });
            return StepResult::Normal;
        }
        Kind::DefineProperty(name) => {
            let obj = if env.this_key == u16::MAX {
                Expr::Undefined
            } else {
                st.read_reg(env.this_key)
            };
            let val = st.take_acc();
            flush!();
            out.push(Stmt::Assign {
                lhs: Expr::Prop(Box::new(obj), name.clone(), false),
                expr: val,
            });
            out.push(Stmt::Comment(format!("属性定义：{name}")));
            return StepResult::Normal;
        }
        Kind::DefineGetterSetter => {
            let regs: Vec<u16> = insn.operands.iter().filter_map(|o| o.reg_key()).collect();
            let name = insn
                .operands
                .iter()
                .find_map(|o| o.as_str())
                .map(|s| Expr::Str(s.to_string()))
                .unwrap_or_else(|| st.take_acc());
            let mut args: Vec<Expr> = vec![st.read_reg(0)];
            args.push(name);
            for r in &regs {
                args.push(st.read_reg(*r));
            }
            flush!();
            out.push(Stmt::ExprStmt(Expr::Call {
                callee: Box::new(Expr::Prop(
                    Box::new(Expr::Ident("Object".into())),
                    "defineProperty".into(),
                    false,
                )),
                args,
                optional: false,
            }));
            return StepResult::Normal;
        }
        Kind::CopyDataProperties => {
            let regs: Vec<u16> = insn.operands.iter().filter_map(|o| o.reg_key()).collect();
            let args: Vec<Expr> = regs.iter().map(|r| st.read_reg(*r)).collect();
            flush!();
            out.push(Stmt::ExprStmt(Expr::Call {
                callee: Box::new(Expr::Prop(
                    Box::new(Expr::Ident("Object".into())),
                    "assign".into(),
                    false,
                )),
                args,
                optional: false,
            }));
            return StepResult::Normal;
        }
        Kind::SpreadArr => {
            st.acc = Some(Expr::Unknown("数组展开 ...".into()));
            flush!();
            out.push(Stmt::Comment("spreadarr：数组展开占位".into()));
            return StepResult::Normal;
        }
        Kind::DynamicImport => {
            let arg = insn
                .operands
                .iter()
                .find_map(|o| o.reg_key())
                .map(|r| st.read_reg(r))
                .or_else(|| {
                    insn.operands
                        .iter()
                        .find_map(|o| o.as_str())
                        .map(|s| Expr::Str(s.to_string()))
                })
                .unwrap_or(Expr::Undefined);
            st.acc = Some(Expr::Call {
                callee: Box::new(Expr::Ident("import".into())),
                args: vec![arg],
                optional: false,
            });
        }
        Kind::InstanceOf => {
            let class_ref = insn
                .operands
                .first()
                .and_then(|o| o.as_imm())
                .and_then(|id| env.names.get(id))
                .map(|n| Expr::ClassRef(safe_ident(n)))
                .unwrap_or_else(|| {
                    insn.operands
                        .iter()
                        .find_map(|o| o.reg_key())
                        .map(|r| st.read_reg(r))
                        .unwrap_or(Expr::Unknown("类引用".into()))
                });
            let obj = insn
                .operands
                .iter()
                .find_map(|o| o.reg_key())
                .map(|r| st.read_reg(r))
                .unwrap_or_else(|| st.take_acc());
            st.acc = Some(Expr::Instanceof(Box::new(obj), Box::new(class_ref)));
        }
        Kind::ThrowFixed(msg) => {
            flush!();
            out.push(Stmt::Throw(Expr::Str(msg)));
            return StepResult::Terminal;
        }
        Kind::LoadBigint(id) => {
            let hint = format!("BigInt 字面量 #{}", id);
            st.acc = Some(Expr::Unknown(hint.clone()));
            flush!();
            out.push(Stmt::Comment(hint));
            return StepResult::Normal;
        }
        // TDZ 检查：累加器为空洞时抛引用错误（累加器不消耗）
        Kind::ThrowUndefinedIfHole(name) => {
            if let Some(acc) = st.acc.clone() {
                let cond = Expr::Un {
                    op: UnOp::Not,
                    e: Box::new(acc),
                };
                let throw = Stmt::Throw(Expr::Str(format!("{name} 未初始化")));
                out.push(Stmt::If {
                    cond,
                    then: vec![throw],
                    els: None,
                });
            }
        }
        Kind::CheckSuper => {
            out.push(Stmt::Comment("super 调用前校验".into()));
        }
        Kind::ResumeMode => {
            st.acc = Some(Expr::Ident("__resume_mode".into()));
        }
        Kind::AsyncResolve(reg) => {
            flush_side_effects(st, out);
            let e = match reg {
                Some(r) => st.read_reg(r),
                None => st.take_acc(),
            };
            flush!();
            out.push(Stmt::Return(Some(e)));
            return StepResult::Terminal;
        }
        Kind::AsyncReject(reg) => {
            flush_side_effects(st, out);
            let e = match reg {
                Some(r) => st.read_reg(r),
                None => st.take_acc(),
            };
            flush!();
            out.push(Stmt::Throw(e));
            return StepResult::Terminal;
        }
        Kind::DefineFunc => {
            // 方法引用形如 `&@pkg.a&1.0.9.#123#e2:(any,...)`，取末段短名
            let short = ref_short_name(&pline.raw);
            st.acc = Some(Expr::Ident(safe_member_name(&short)));
        }
        Kind::TypeOf => {
            let e = operand_expr(st, insn.operands.first());
            st.acc = Some(Expr::Un {
                op: UnOp::Typeof,
                e: Box::new(e),
            });
        }
        Kind::CopyRestArgs => {
            st.acc = Some(Expr::Unknown("剩余参数 ...rest".into()));
        }
        Kind::LoadGlobal(name) => {
            st.acc = Some(global_expr(&name));
        }
        Kind::StoreGlobal(name) => {
            let val = st.take_acc();
            flush!();
            out.push(Stmt::Assign {
                lhs: global_expr(&name),
                expr: val,
            });
            return StepResult::Normal;
        }
        Kind::LoadModule(id) => {
            st.acc = Some(Expr::ModRef(id, env.names.get(id).map(|s| s.to_string())));
        }
        Kind::StoreModule(id) => {
            let val = st.take_acc();
            let lhs = Expr::ModRef(id, env.names.get(id).map(|s| s.to_string()));
            flush!();
            out.push(Stmt::Assign { lhs, expr: val });
            return StepResult::Normal;
        }
        Kind::Call(shape) | Kind::SuperCall(shape) => {
            let mut callee = st.take_acc();
            if is_super_call {
                callee = Expr::Ident("super".into());
            } else if matches!(callee, Expr::Undefined | Expr::Unknown(_)) {
                // 累加器来源丢失时尝试字面量池名称表
                if let Some(mid) = insn.operands.first().and_then(|o| o.as_imm()) {
                    if let Some(name) = env.names.get(mid) {
                        callee = Expr::Ident(safe_member_name(name));
                    }
                }
            }
            let args = collect_args(st, &insn, shape);
            st.acc = Some(Expr::Call {
                callee: Box::new(callee),
                args,
                optional: false,
            });
        }
        Kind::NewObj { class, argc, first } => {
            let cname = class
                .or_else(|| {
                    insn.operands
                        .first()
                        .and_then(|o| o.as_imm())
                        .and_then(|id| env.names.get(id))
                        .map(safe_ident)
                })
                .unwrap_or_else(|| "__class".into());
            let args = match (first, argc) {
                (Some(f), n) if n > 0 => (f..f.saturating_add(n as u16))
                    .map(|r| st.read_reg(r))
                    .collect(),
                _ => vec![],
            };
            let mut stmts = vec![];
            if argc > 0 && first.is_none() {
                stmts.push(Stmt::Comment("new 对象参数无法静态定位".into()));
            }
            st.acc = Some(Expr::New { class: cname, args });
            if !stmts.is_empty() {
                flush!();
                out.extend(stmts);
                return StepResult::Normal;
            }
        }
        Kind::EmptyObject => {
            st.acc = Some(Expr::Obj(vec![]));
        }
        Kind::EmptyArray => {
            st.acc = Some(Expr::Arr(vec![]));
        }
        Kind::BufferLiteral { array, id } => {
            let hint = format!(
                "字面量池 #{}（{}）",
                id,
                if array { "数组" } else { "对象" }
            );
            st.acc = Some(Expr::Unknown(hint.clone()));
            flush!();
            out.push(Stmt::Comment(hint));
            return StepResult::Normal;
        }
        Kind::DefineClass(name) => {
            // 字面量缓冲里首段 `string:"类名"` 更可靠；退回分类阶段提取的文本
            let cleaned = buffer_class_name(&pline.raw).unwrap_or_else(|| name.clone());
            st.acc = Some(Expr::ClassRef(safe_ident(&cleaned)));
            flush!();
            out.push(Stmt::Comment(format!("定义类 {cleaned}")));
            return StepResult::Normal;
        }
        Kind::LexNew(n) => {
            let _ = n;
        }
        Kind::LexPop => {}
        Kind::LexStore(d, s) => {
            let name = st.lex_name(d, s);
            let val = st.take_acc();
            flush!();
            out.push(Stmt::Assign {
                lhs: Expr::Ident(name),
                expr: val,
            });
            return StepResult::Normal;
        }
        Kind::LexLoad(d, s) => {
            let name = st.lex_name(d, s);
            st.acc = Some(Expr::Ident(name));
        }
        Kind::Throw => {
            let e = st.take_acc();
            flush!();
            out.push(Stmt::Throw(e));
            return StepResult::Terminal;
        }
        Kind::Ret(kind) => {
            let e = st.take_acc();
            flush!();
            match kind {
                RetKind::Undefined => {
                    // 无消费者的副作用调用保留为语句
                    if is_side_effectful(&e) {
                        out.push(Stmt::ExprStmt(e));
                    }
                    out.push(Stmt::Return(None));
                }
                _ => {
                    let ret = match e {
                        Expr::Undefined => None,
                        other => Some(other),
                    };
                    out.push(Stmt::Return(ret));
                }
            }
            return StepResult::Terminal;
        }
        Kind::Async => {
            env.async_flag.set(true);
        }
        Kind::Await => {
            let e = st.take_acc();
            st.acc = Some(Expr::Await(Box::new(e)));
        }
        Kind::Nop => {}
        Kind::Other => {
            flush!();
            out.push(Stmt::Raw(vec!["未还原的指令:".to_string(), pline.raw.clone()]));
            return StepResult::Normal;
        }
    }

    flush!();
    StepResult::Normal
}

/// 收集调用参数表达式。
fn collect_args(st: &mut Interp, insn: &instr::Insn, shape: instr::CallShape) -> Vec<Expr> {
    match shape.mode {
        CallMode::Fixed(_n) => {
            let regs: Vec<u16> = insn.operands[1.min(insn.operands.len())..]
                .iter()
                .filter_map(|o| o.reg_key())
                .collect();
            let args: &[u16] = if shape.has_this && !regs.is_empty() {
                &regs[1..]
            } else {
                &regs
            };
            args.iter().map(|r| st.read_reg(*r)).collect()
        }
        CallMode::Range => {
            let argc = insn
                .operands
                .get(1)
                .and_then(|o| o.as_imm())
                .unwrap_or(0)
                .max(0) as usize;
            let first = insn.operands.get(2).and_then(|o| o.reg_key()).unwrap_or(0);
            (first..first.saturating_add(argc as u16))
                .map(|r| st.read_reg(r))
                .collect()
        }
    }
}

/// 把操作数转为表达式（寄存器读取会推进符号状态）。
fn operand_expr(st: &mut Interp, op: Option<&Operand>) -> Expr {
    match op {
        Some(Operand::Reg(r)) => st.read_reg(*r),
        Some(other) => literal_expr(other),
        None => Expr::Undefined,
    }
}

// ---------- 标识符与字段 ----------

/// 是否合法的 JS 标识符。
fn is_plain_ident(s: &str) -> bool {
    !s.is_empty()
        && s.chars().enumerate().all(|(i, c)| {
            c == '$' || c == '_' || c.is_ascii_alphabetic() || (i > 0 && c.is_ascii_digit())
        })
}

/// 从 defineclasswithbuffer 的原始行提取类名：首段 `string:"X"`。
fn buffer_class_name(raw: &str) -> Option<String> {
    let key = "string:\"";
    let start = raw.find(key)? + key.len();
    let end = raw[start..].find('"')? + start;
    if end > start {
        Some(raw[start..end].to_string())
    } else {
        None
    }
}

/// 从方法引用（definefunc / definemethod 操作数）提取短名。
///
/// `&@pkg.a&1.0.9.#123#e2:(any,...)` → `e2`；
/// `&@pkg.a&1.0.9.static_initializer:(...)` → `static_initializer`。
fn ref_short_name(raw: &str) -> String {
    // 引用 token 含 '('（参数列表），先定位它
    let tok = raw
        .split(|c: char| c == ',' || c.is_whitespace())
        .find(|t| t.contains('('))
        .unwrap_or(raw);
    let head = tok.split('(').next().unwrap_or(tok);
    let seg = head.rsplit('#').find(|s| !s.is_empty()).unwrap_or(head);
    let seg = seg.trim_start_matches(['&', '@']);
    seg.trim_end_matches(':').to_string()
}

/// 全局变量表达式（非法标识符退化为 globalThis["..."]）。
fn global_expr(name: &str) -> Expr {
    if is_plain_ident(name) {
        Expr::Ident(name.to_string())
    } else {
        Expr::Prop(
            Box::new(Expr::Ident("globalThis".into())),
            name.to_string(),
            true,
        )
    }
}

/// 清理为安全的类型名（非法字符替换为下划线）。
pub fn safe_ident(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '$' {
                c
            } else {
                '_'
            }
        })
        .collect();
    let cleaned = cleaned.trim_matches('_').to_string();
    if cleaned.is_empty()
        || cleaned
            .chars()
            .next()
            .map(|c| c.is_ascii_digit())
            .unwrap_or(false)
    {
        format!("_{cleaned}")
    } else {
        cleaned
    }
}

/// 成员名：合法则原样保留，否则清理。
fn safe_member_name(name: &str) -> String {
    if is_plain_ident(name) {
        name.to_string()
    } else {
        safe_ident(name)
    }
}

// ---------- 语句渲染 ----------

/// 渲染语句列表为带缩进的源码。
pub fn render_stmts(stmts: &[Stmt], depth: usize, out: &mut String) {
    let pad = "    ".repeat(depth);
    for s in stmts {
        match s {
            Stmt::Decl { name, init } => match init {
                Some(e) => out.push_str(&format!("{pad}let {name} = {};\n", render_expr(e, 1))),
                None => out.push_str(&format!("{pad}let {name};\n")),
            },
            Stmt::Assign { lhs, expr } => out.push_str(&format!(
                "{pad}{} = {};\n",
                render_expr(lhs, 1),
                render_expr(expr, 1)
            )),
            Stmt::ExprStmt(e) => out.push_str(&format!("{pad}{};\n", render_expr(e, 1))),
            Stmt::Return(Some(e)) => out.push_str(&format!("{pad}return {};\n", render_expr(e, 1))),
            Stmt::Return(None) => out.push_str(&format!("{pad}return;\n")),
            Stmt::Throw(e) => out.push_str(&format!("{pad}throw {};\n", render_expr(e, 1))),
            Stmt::If { cond, then, els } => {
                out.push_str(&format!("{pad}if ({}) {{\n", render_expr(cond, 1)));
                render_stmts(then, depth + 1, out);
                match els {
                    Some(es) if !es.is_empty() => {
                        out.push_str(&format!("{pad}}} else {{\n"));
                        render_stmts(es, depth + 1, out);
                        out.push_str(&format!("{pad}}}\n"));
                    }
                    _ => out.push_str(&format!("{pad}}}\n")),
                }
            }
            Stmt::While { cond, body } => {
                out.push_str(&format!("{pad}while ({}) {{\n", render_expr(cond, 1)));
                render_stmts(body, depth + 1, out);
                out.push_str(&format!("{pad}}}\n"));
            }
            Stmt::TryCatch { body, catch } => {
                out.push_str(&format!("{pad}try {{\n"));
                render_stmts(body, depth + 1, out);
                out.push_str(&format!("{pad}}} catch (e) {{\n"));
                render_stmts(catch, depth + 1, out);
                out.push_str(&format!("{pad}}}\n"));
            }
            Stmt::Comment(text) => out.push_str(&format!("{pad}// {text}\n")),
            Stmt::Raw(lines) => {
                for l in lines {
                    out.push_str(&format!("{pad}// {l}\n"));
                }
            }
        }
    }
}

// ---------- 类级辅助 ----------

/// 解析 `.field` 行为 (修饰符, 名称, 类型)。
fn parse_field(field: &str) -> (String, String, &'static str) {
    let body = field.strip_prefix(".field").unwrap_or(field).trim();
    let flags = [
        "public",
        "private",
        "protected",
        "internal",
        "static",
        "<static>",
        "readonly",
        "final",
    ];
    let mut mods = String::new();
    let mut name = String::new();
    for tok in body.split_whitespace() {
        if flags.contains(&tok) {
            if tok == "static" || tok == "<static>" {
                mods.push_str("static ");
            } else if tok != "final" {
                mods.push_str(tok);
                mods.push(' ');
            }
        } else if name.is_empty() {
            name = tok.split(':').next().unwrap_or(tok).to_string();
        }
    }
    let ty = match body.rsplit_once(':') {
        Some((_, t)) => {
            let t = t.trim();
            if t.is_empty() || t.contains(' ') {
                "any"
            } else {
                Sig::ts_type(t)
            }
        }
        None => "any",
    };
    (mods, name, ty)
}

/// 从 access_flags 文本提取类修饰符。
fn class_modifiers(flags: Option<&str>) -> String {
    let mut out = String::new();
    if let Some(f) = flags {
        if f.contains("abstract") {
            out.push_str("abstract ");
        }
    }
    out.push_str("export ");
    out
}

/// 方法在 record 中的原顺序（稳定排序键）。
fn method_order(rec: &PaRecord, m: &PaMethod) -> usize {
    rec.methods
        .iter()
        .position(|x| x.signature == m.signature)
        .unwrap_or(usize::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lines(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn renders_straight_line_arith() {
        // 静态方法：v0 = p1，v1 起为临时寄存器
        let sig = sig::parse("any LEntry;.calc(i32) <static true>");
        let body = lines(&[
            "\tldai 0x2",
            "\tsta v1",
            "\tlda v0",
            "\tadd2 v1, v0 # acc = 2 + p1",
            "\treturnobject",
        ]);
        let text = render_method_body(&sig, &body, &Names::default());
        // 常量传播后直接内联：2 + p1
        assert!(
            text.contains("return") && text.contains("+"),
            "text: {text}"
        );
        assert!(
            text.contains("(2 + p1)") || text.contains("2 + p1"),
            "text: {text}"
        );
    }

    #[test]
    fn structures_if_else_and_returns() {
        let sig = sig::parse("any LEntry;.pick(any) <static false>");
        let body = lines(&[
            "\tlda v0",
            "\tjeqz L0007",
            "\tldai 0xa",
            "\treturnobject",
            "\tjmp L0008",
            "L0007:",
            "\tldai 0x14",
            "\treturnobject",
            "L0008:",
            "\treturnundefined",
        ]);
        let text = render_method_body(&sig, &body, &Names::default());
        // 实例方法 v0 = this
        assert!(text.contains("if (this) {"), "text: {text}");
        assert!(text.contains("} else {"));
        assert!(text.contains("return 10;"));
        assert!(text.contains("return 20;"));
        assert!(text.trim_end().ends_with("return;"));
    }

    #[test]
    fn structures_while_loop_with_call() {
        let sig = sig::parse("void funcmain() <static true>");
        let body = lines(&[
            "\tldai 0x5",
            "\tsta v0",
            "L0001:",
            "\tlda v0",
            "\tjeqz L0002",
            "\tldglobalvar 0x0, \"console\"",
            "\tldobjbyname 0x1, \"log\"",
            "\tsta v1",
            "\tlda v1",
            "\tcallarg0 0x2",
            "\tdec v0, 0x1",
            "\tjmp L0001",
            "L0002:",
            "\treturnundefined",
        ]);
        let text = render_method_body(&sig, &body, &Names::default());
        assert!(text.contains("while ("), "text: {text}");
        // 循环体里的 console.log() 调用必须保留为语句
        assert!(text.contains("console.log();"), "text: {text}");
        // 计数器递减
        assert!(
            text.contains("v0 = v0 - 1") || text.contains("- 1;"),
            "text: {text}"
        );
    }

    #[test]
    fn keeps_property_chain_and_args() {
        let sig = sig::parse("any LEntry;.greet(any) <static false>");
        let body = lines(&[
            "\tlda v0",
            "\tldobjbyname 0x1, \"name\"",
            "\tstobjbyname 0x2, \"title\"",
            "\tlda.str \"hi {}\"",
            "\tsta v2",
            "\tldglobalvar 0x0, \"console\"",
            "\tldobjbyname 0x3, \"log\"",
            "\tsta v3",
            "\tlda v3",
            "\tcallarg1 0x4, v2",
            "\treturnobject",
        ]);
        let text = render_method_body(&sig, &body, &Names::default());
        assert!(text.contains(".title = "), "text: {text}");
        assert!(text.contains("console.log(\"hi {}\");"), "text: {text}");
    }

    #[test]
    fn falls_back_to_raw_block_for_unknown_ops() {
        let sig = sig::parse("void LEntry;.weird() <static true>");
        let body = lines(&["\tldai 0x1", "\tfroptrange123 v1, v2", "\treturnundefined"]);
        let text = render_method_body(&sig, &body, &Names::default());
        assert!(
            text.contains("未还原的指令") || text.contains("froptrange123"),
            "text: {text}"
        );
        assert!(text.contains("return;"));
    }

    #[test]
    fn emits_class_skeleton_from_record() {
        use crate::pa::PaFile;
        let pa_text = r#"
.record Lentry.src.main.ets.pages.Index; {
	.access_flags public
	.source_file entry|1.0.0|src/main/ets/pages/Index.ts
	.field public message
}

.function any Lentry.src.main.ets.pages.Index;.ctor(any) <static false> {
	lda.str "hello"
	sta v1
	lda v1
	stobjbyname 0x0, "message"
	lda v0
	returnobject
}

.function any Lentry.src.main.ets.pages.Index;.get(any) <static true> {
	ldai 0x1
	returnobject
}
"#;
        let pa = PaFile::parse(pa_text);
        let names = Names::default();
        let out = crate::decompiler::record_to_arkts(&pa.records[0], &pa.records, &names);
        assert!(
            out.contains("class entry_src_main_ets_pages_Index {"),
            "out: {out}"
        );
        assert!(out.contains("message: any"));
        assert!(out.contains("constructor(p1: any)"));
        assert!(out.contains("static get(p1: any): any"));
        assert!(out.contains("\"hello\""));
    }

    #[test]
    fn infers_fields_from_method_body_when_field_missing() {
        use crate::pa::PaFile;
        let pa_text = r#"
.record Lfoo.Bar; {
	.access_flags public
}

.function any Lfoo.Bar;.ctor(any) <static false> {
	lda.str "v"
	sta v1
	lda v1
	stobjbyname 0x0, "value"
	lda v0
	returnobject
}
"#;
        let pa = PaFile::parse(pa_text);
        let out = crate::decompiler::record_to_arkts(&pa.records[0], &pa.records, &Names::default());
        assert!(
            out.contains("public value: any"),
            "out: {out}"
        );
    }

    #[test]
    fn emits_import_for_sibling_record_reference() {
        use crate::pa::PaFile;
        let pa_text = r#"
.record Lfoo.Bar; {
	.access_flags public
}

.record Lfoo.Helper; {
	.access_flags public
}

.function any Lfoo.Bar;.use(any) <static true> {
	ldmodulevar 0x0, v0
	returnobject
}
"#;
        let mut names = Names::default();
        names.set(0, "Helper");
        let pa = PaFile::parse(pa_text);
        let out = crate::decompiler::record_to_arkts(&pa.records[0], &pa.records, &names);
        assert!(
            out.contains("import { Helper } from 'foo.Helper';"),
            "out: {out}"
        );
    }
}
