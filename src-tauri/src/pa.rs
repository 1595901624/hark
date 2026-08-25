use std::collections::HashMap;

/// Parses the official `ark_disasm` .pa output into records / fields / methods.
///
/// Real layout of the tool: first all `.record { fields }` blocks (records
/// never contain functions), then all `.function` blocks at top level. The
/// owning record of a function is encoded in its qualified name:
/// `.function <ret> <RecordName>.<methodName>(...) <metadata> { ... }`
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
    /// foreign/external records are declared without a body
    pub is_external: bool,
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
            is_external: false,
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

/// Splits `.function <ret> <Qualified.methodName>(...) ...` into
/// (owner raw record name, method name). Global functions without a
/// qualified owner yield an empty owner.
fn split_signature(signature: &str) -> (String, String) {
    let paren = signature.find('(').unwrap_or(signature.len());
    let head = &signature[..paren];
    let qualified = head.rsplit(' ').next().unwrap_or(head);
    match qualified.rfind('.') {
        Some(pos) => (qualified[..pos].to_string(), qualified[pos + 1..].to_string()),
        None => (String::new(), qualified.to_string()),
    }
}

#[derive(Debug, Clone, Default)]
pub struct PaFile {
    pub records: Vec<PaRecord>,
}

impl PaFile {
    /// Parses ark_disasm output.
    ///
    /// Layout of the official tool: first all `.record { fields }` blocks,
    /// then all `.function` blocks at top level. A function's owning record is
    /// encoded in its qualified name: `<ret> <RecordName>.<methodName>(...)`.
    pub fn parse(text: &str) -> PaFile {
        let mut records: Vec<PaRecord> = Vec::new();
        let mut index: HashMap<String, usize> = HashMap::new();
        let mut cur_record: Option<usize> = None;
        // (record idx, method idx) while inside a function body
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
                        // method of a record that was not emitted (e.g. system
                        // type) or a global function -> synthesize a record
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
        // string literal containing '}' must not terminate the body early
        assert_eq!(s.methods[0].body.len(), 4, "body: {:?}", s.methods[0].body);
        assert!(s.methods[0].body.iter().any(|l| l.contains("lda.str")));

        let foo = &pa.records[2];
        assert_eq!(foo.display_name, "com.example.Foo");
        assert_eq!(foo.methods[0].name, "bar");

        let global = &pa.records[3];
        assert_eq!(global.display_name, "<global>");
        assert_eq!(global.methods[0].name, "funcmain");
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
