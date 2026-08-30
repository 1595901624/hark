//! 方舟字节码 → ArkTS 还原（反编译）子系统集成。
//!
//! 输入是 [`crate::pa`] 解析后的 pandasm 结构（record / field / method），
//! 输出为尽力还原的 ArkTS 源码文本。整体策略：
//!
//! 1. **指令级解析**（[`instr`]）：标签、操作码、操作数结构化；
//! 2. **符号执行**（[`expr`]）：寄存器与累加器维护表达式树，
//!    延迟物化临时变量保持输出整洁；
//! 3. **控制流还原**（[`emit`]）：识别 if/else 与 while 形态，
//!    未匹配的指令以原始汇编块注释兜底；
//! 4. **名称解析**（[`resolve`]）：利用 ark_disasm 的字面量池 dump
//!    把调用立即数映射回方法名。

mod emit;
mod expr;
mod instr;
pub mod resolve;
pub mod sig;

use crate::pa::{PaMethod, PaRecord};

use self::resolve::Names;

/// 还原整个类（record）为 ArkTS 源码。
pub fn record_to_arkts(rec: &PaRecord, siblings: &[PaRecord], names: &Names) -> String {
    emit::record_to_arkts(rec, siblings, names)
}

/// 还原单个方法为独立函数源码。
pub fn method_to_arkts(owner_display: &str, m: &PaMethod, names: &Names) -> String {
    let s = sig::parse(&m.signature);
    let owner = if s.owner.is_empty() {
        owner_display
    } else {
        &s.owner
    };
    emit::method_to_arkts(owner, &s.name, &m.signature, &m.body, names)
}

pub use resolve::{parse_literal_names, Names as LiteralNames};
