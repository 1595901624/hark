/// Parses the official `ark_disasm` .pa output into records / fields / methods.
///
/// The text format (simplified):
/// ```text
/// # comments
/// .record Lstd/core/String; {
///     .access_flags public
///     .source_file std.core.String
///     .field ...
///     .function any Lstd/core/String;.toString(...) <...> {
///         instruction...
///         label:
///         instruction...
///     }
/// }
/// ```
#[derive(Debug, Clone)]
pub struct PaMethod {
    /// full `.function ...` header line without the leading directive
    pub signature: String,
    /// short display name, e.g. `toString`
    pub name: String,
    /// raw body lines (instructions / labels), trimmed-right, original indent removed
    pub body: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct PaRecord {
    /// raw record name as written in the .pa file, e.g. `Lstd/core/String;`
    pub raw_name: String,
    /// display name: dots instead of slashes, descriptor markers removed
    pub display_name: String,
    pub source_file: Option<String>,
    pub access_flags: Option<String>,
    pub fields: Vec<String>,
    pub methods: Vec<PaMethod>,
}

impl PaRecord {
    fn new(raw_name: &str) -> Self {
        let display_name = prettify_name(raw_name);
        PaRecord {
            raw_name: raw_name.to_string(),
            display_name,
            source_file: None,
            access_flags: None,
            fields: vec![],
            methods: vec![],
        }
    }
}

pub fn prettify_name(raw: &str) -> String {
    let name = raw.trim();
    let name = name.strip_prefix('L').unwrap_or(name);
    let name = name.strip_suffix(';').unwrap_or(name);
    name.replace('/', ".")
}

fn method_display_name(signature: &str) -> String {
    // `.function <ret> <qualified>(<args>) ...` -> take token before '('
    let paren = signature.find('(').unwrap_or(0);
    let head = &signature[..paren];
    let token = head.rsplit(' ').next().unwrap_or(head);
    token.rsplit('.').next().unwrap_or(token).to_string()
}

#[derive(Debug, Clone, Default)]
pub struct PaFile {
    pub records: Vec<PaRecord>,
}

impl PaFile {
    pub fn parse(text: &str) -> PaFile {
        let mut pa = PaFile::default();
        let mut records: Vec<PaRecord> = Vec::new();
        // state: current record + optional index of the open method
        let mut cur: Option<PaRecord> = None;
        let mut open_method: Option<usize> = None;

        macro_rules! flush_record {
            () => {
                if let Some(rec) = cur.take() {
                    records.push(rec);
                }
                open_method = None;
            };
        }

        for line in text.lines() {
            let trimmed = line.trim();

            if trimmed.is_empty() || trimmed.starts_with('#') {
                continue;
            }

            if let Some(rest) = trimmed.strip_prefix(".record") {
                flush_record!();
                let mut it = rest.trim().split_whitespace();
                let name = it.next().unwrap_or("").to_string();
                cur = Some(PaRecord::new(&name));
                continue;
            }

            if trimmed == "}" {
                if open_method.is_some() {
                    open_method = None;
                } else {
                    flush_record!();
                }
                continue;
            }

            let Some(rec) = cur.as_mut() else {
                continue;
            };

            if let Some(rest) = trimmed.strip_prefix(".function") {
                let signature = rest.trim().to_string();
                let name = method_display_name(&signature);
                rec.methods.push(PaMethod {
                    signature,
                    name,
                    body: vec![],
                });
                open_method = Some(rec.methods.len() - 1);
                continue;
            }

            match open_method {
                Some(mi) => rec.methods[mi].body.push(line.trim_end().to_string()),
                None => {
                    if let Some(rest) = trimmed.strip_prefix(".source_file") {
                        rec.source_file = Some(rest.trim().trim_matches('"').to_string());
                    } else if let Some(rest) = trimmed.strip_prefix(".access_flags") {
                        rec.access_flags = Some(rest.trim().to_string());
                    } else if trimmed.starts_with(".field") {
                        rec.fields.push(trimmed.to_string());
                    }
                }
            }
        }

        flush_record!();
        pa.records = records;
        pa
    }

    pub fn render_record(&self, idx: usize) -> Option<String> {
        let rec = self.records.get(idx)?;
        let mut out = String::new();
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
            out.push_str(&format!("    .function {}\n", m.signature));
            out.push_str("    {\n");
            for line in &m.body {
                if line.starts_with(char::is_whitespace) {
                    out.push_str(line);
                } else {
                    out.push_str(&format!("        {line}\n"));
                }
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

    const SAMPLE: &str = r#"
# Some header comment
.record Lstd/core/String; {
	.access_flags public
	.source_file std.core.String
	.field public length

.function any Lstd/core/String;.toString(...) <static false> {
	mov v0, v1
	lda.str "brace } inside"
	L0001: ldai 0x2a
	return
}
}

.record Lcom/example/Foo; {
	.function void Lcom/example/Foo;.bar(i32) <static true> {
		ldai 0x1
		return
	}
}
"#;

    #[test]
    fn parses_records_methods_and_bodies() {
        let pa = PaFile::parse(SAMPLE);
        assert_eq!(pa.records.len(), 2);

        let s = &pa.records[0];
        assert_eq!(s.display_name, "std.core.String");
        assert_eq!(s.source_file.as_deref(), Some("std.core.String"));
        assert_eq!(s.access_flags.as_deref(), Some("public"));
        assert_eq!(s.fields.len(), 1);
        assert_eq!(s.methods.len(), 1);
        assert_eq!(s.methods[0].name, "toString");
        // string literal containing '}' must not terminate the body early
        assert_eq!(
            s.methods[0].body.len(),
            4,
            "body lines: {:?}",
            s.methods[0].body
        );
        assert!(s.methods[0].body.iter().any(|l| l.contains("lda.str")));

        let foo = &pa.records[1];
        assert_eq!(foo.display_name, "com.example.Foo");
        assert_eq!(foo.methods[0].name, "bar");
    }

    #[test]
    fn renders_record_back_to_text() {
        let pa = PaFile::parse(SAMPLE);
        let text = pa.render_record(0).unwrap();
        assert!(text.starts_with(".record Lstd/core/String; {"));
        assert!(text.contains(".function any Lstd/core/String;.toString(...)"));
        assert!(text.trim_end().ends_with('}'));
    }
}
