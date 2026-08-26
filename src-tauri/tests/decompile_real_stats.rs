//! 真实 `.pa` 文件的兜底块统计（数据驱动迭代工具）。
//!
//! 通过环境变量启用：
//!
//! ```text
//! ABCDE_REAL_PA=<modules.pa 路径> cargo test --test decompile_real_stats -- --nocapture
//! ```
//!
//! 对文件中全部 record 执行 ArkTS 还原，统计输出中残留的
//! 「未还原的指令」兜底块数量，并按操作码聚合定位剩余缺口。

use std::collections::BTreeMap;

use abcde_lib::decompiler;
use abcde_lib::pa::PaFile;

#[test]
fn real_file_fallback_stats() {
    let Ok(path) = std::env::var("ABCDE_REAL_PA") else {
        eprintln!("real_file_fallback_stats: 未设置 ABCDE_REAL_PA，跳过");
        return;
    };
    let text = std::fs::read_to_string(&path).expect("读取 .pa 失败");
    let pa = PaFile::parse(&text);
    let names = decompiler::parse_literal_names(&text);

    let mut blocks = 0usize;
    // 兜底块内出现的操作码 -> 次数（按出现次数降序报告）
    let mut ops: BTreeMap<String, usize> = BTreeMap::new();
    let mut methods = 0usize;
    let mut per_record: Vec<(String, usize)> = vec![];

    for rec in &pa.records {
        if rec.is_external {
            continue;
        }
        let out = decompiler::record_to_arkts(rec, &names);
        methods += rec.methods.len();
        let before = blocks;
        scan_blocks(&out, &mut blocks, &mut ops);
        if blocks > before {
            per_record.push((rec.display_name.clone(), blocks - before));
        }
    }
    per_record.sort_by(|a, b| b.1.cmp(&a.1));
    println!("---- 兜底最多的 record ----");
    for (name, n) in per_record.iter().take(8) {
        println!("  [{n:3}] {name}");
    }

    println!("==== 真实文件还原统计 ====");
    println!("records: {}", pa.records.len());
    println!("methods: {methods}");
    println!("未还原块: {blocks}");

    let mut ranked: Vec<_> = ops.into_iter().collect();
    ranked.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    for (op, n) in &ranked {
        println!("  {op:<40} {n}");
    }

    if blocks > 0 {
        eprintln!("提示：仍有 {blocks} 个未还原块（见上方分布），可继续针对性迭代");
    }
}

/// 从还原文本中提取「/* 未还原的指令: ... */」块内的操作码。
fn scan_blocks(text: &str, blocks: &mut usize, ops: &mut BTreeMap<String, usize>) {
    let mut inside = false;
    for line in text.lines() {
        let t = line.trim();
        if !inside {
            if t.starts_with("/*") && t.contains("未还原") {
                *blocks += 1;
                inside = true;
            }
            continue;
        }
        if t.starts_with("*/") || t.ends_with("*/") {
            inside = false;
            continue;
        }
        // 行格式：[label:] opcode operands...
        let body = match t.split_once(':') {
            Some((head, rest)) if is_label(head) => rest,
            _ => t,
        };
        let opcode = body.split_whitespace().next().unwrap_or("");
        if !opcode.is_empty() {
            *ops.entry(opcode.to_string()).or_insert(0) += 1;
        }
    }
}

/// 判断 token 是否形如标签名。
fn is_label(tok: &str) -> bool {
    !tok.is_empty()
        && tok.chars().next().map(|c| c.is_ascii_alphabetic() || c == '_' || c == '$').unwrap_or(false)
        && tok.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '$' | '.'))
}