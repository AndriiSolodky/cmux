//! Keys from any provider: an agent stores a key it has, then enters it where it is needed, and
//! never sees, prints or logs the value (Leo, 2026-11-15: "can you do the keys without cloudflare?
//! ... as an app feature letting agents safely write keys and store them or enter them into
//! whatever").
//!
//!     cmux keys put NAME [--purpose TEXT] [--hosts H,H] [--ttl 90d] [--replace]   value on stdin
//!     cmux keys generate NAME [--bytes 32] [--format base64url|hex|alnum] [...put flags]
//!     cmux keys request NAME --purpose TEXT [--hosts H,H] [--ttl 90d] [--timeout 15m]
//!     cmux keys use NAME[=VAR] [NAME --env VAR]... [--no-mask] -- CMD [ARGS...]
//!     cmux keys write NAME --to TARGET [--to TARGET]...
//!     cmux keys fill NAME [--tab TAB] --selector CSS [--type]
//!     cmux keys rm NAME                                          (or cmux keys revoke NAME)
//!
//! - **Where a value lives.** The OS secret store (the login Keychain on a Mac, the Secret Service
//!   on Linux), item `key.NAME` of the store the machine vault uses (`acpmux::vault::store`). There
//!   is no file or memory fallback: a machine with no OS store refuses. The audit
//!   (`~/.config/cmux/keys.json`, 0600) gets one record per key: its name, purpose, the hosts it is
//!   for, who stored it and who asked, when it expires, every place a copy was written (`stores`)
//!   and every place it was entered (`uses`). Never a value.
//! - **How a value comes in.** stdin only (a pipe from the provider's CLI or API, or a no-echo
//!   prompt at a terminal), `generate` (the OS random source), or the person: `request` asks the
//!   cmux app, which shows the ask in Settings > Keys with a secure field, and stores what the
//!   person pastes with `put`, never through a chat.
//! - **How a value goes out.** Only by reference, by this process: `use` puts it in a command's
//!   env and masks it in what the command prints (as `op run` does); `write` copies it into a
//!   GitHub secret, a cloud secret, the machine vault, a 0600 file, a JSON or TOML field or an env
//!   file; `fill` types it into a field of a cmux browser tab, refusing a page outside the key's
//!   hosts. The `keys_fill` MCP tool also types it into a desktop app through Computer Use. A
//!   reply names the key and the target, never the value.
//!
//! This keeps values out of transcripts, logs and a model's context. It is not a wall against an
//! agent that sets out to read the value: a command it runs with `use` gets the value, and the OS
//! store answers any process of this user.

use std::io::{Read as _, Write as _};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use zeroize::Zeroizing;

use super::{AuditLock, Paths, Sinks, Store, UsageError, now_secs, read_audit, requester, rfc3339, write_audit};

/// The OS store item of key `NAME`: `key.NAME` (an env name has no dot, so it never meets a
/// machine vault entry or a kept key).
pub(in crate::cli) fn item(name: &str) -> String {
    format!("key.{name}")
}

/// A value short enough to occur by chance in ordinary output is no secret, and masking it
/// would garble that output.
pub(in crate::cli) const MIN_VALUE_CHARS: usize = 8;
pub(in crate::cli) const MAX_VALUE_BYTES: usize = 64 * 1024;
/// What every masked occurrence of a value prints as.
pub(in crate::cli) const MASK: &str = "<concealed by cmux keys>";
/// The most `uses` one record keeps; the oldest goes first.
const MAX_USES: usize = 32;
const DEFAULT_REQUEST_TIMEOUT: Duration = Duration::from_secs(15 * 60);
const MAX_REQUEST_TIMEOUT: Duration = Duration::from_secs(24 * 3_600);
const MAX_PURPOSE_CHARS: usize = 300;

pub(super) const USAGE: &str = "cmux keys put NAME [--purpose TEXT] [--hosts H,H] [--ttl 90d] [--replace]   (value on stdin)\n       \
cmux keys generate NAME [--bytes 32] [--format base64url|hex|alnum] [--purpose TEXT] [--hosts H,H] [--ttl 90d]\n       \
cmux keys request NAME --purpose TEXT [--hosts H,H] [--ttl 90d] [--timeout 15m]   (asks the person in the cmux app)\n       \
cmux keys use NAME[=VAR] [NAME --env VAR]... [--no-mask] -- CMD [ARGS...]\n       \
cmux keys write NAME --to TARGET...   TARGET: gh-secret:OWNER/REPO[@ENV]:SECRET, keychain:[OWNER/REPO:]SECRET, vault:VAR,\n                                         file:PATH, json:PATH#a.b, toml:PATH#a.b or env-file:PATH#VAR\n       \
cmux keys fill NAME [--tab TAB] --selector CSS [--type]\n       \
cmux keys rm NAME";

#[derive(Debug, Clone, PartialEq, Eq)]
pub(in crate::cli) struct Put {
    pub name: String,
    pub purpose: Option<String>,
    pub hosts: Vec<String>,
    pub ttl: Option<Duration>,
    pub replace: bool,
    /// The agent that asked the person for it (`request`, recorded by the app).
    pub asked_by: Option<String>,
    /// The person pasted it in the app (`--from-person`, which only the app passes).
    pub from_person: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(in crate::cli) enum Format {
    Base64Url,
    Hex,
    Alnum,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(in crate::cli) struct Use {
    /// `(key name, env var)` pairs.
    pub keys: Vec<(String, String)>,
    pub mask: bool,
    pub argv: Vec<String>,
}

/// Where `write` copies a value.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(in crate::cli) enum Target {
    /// A GitHub secret, a cloud secret or a machine vault entry; the store's prefix is the exact
    /// name.
    Store(Store),
    File(PathBuf),
    Json(PathBuf, Vec<String>),
    Toml(PathBuf, Vec<String>),
    EnvFile(PathBuf, String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(in crate::cli) struct Fill {
    pub name: String,
    pub tab: Option<String>,
    pub selector: String,
    /// Type key by key (`browser.page.type`) instead of setting the field (`browser.page.fill`).
    pub typing: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(in crate::cli) enum Local {
    Put(Put),
    Generate { put: Put, bytes: usize, format: Format },
    Request { put: Put, timeout: Duration },
    Use(Use),
    Write { name: String, targets: Vec<Target> },
    Fill(Fill),
}

/// An env name, as GitHub and shells take it: `[A-Z_][A-Z0-9_]*`, at most 80.
pub(in crate::cli) fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 80
        && name.chars().next().is_some_and(|c| c.is_ascii_uppercase() || c == '_')
        && name.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_')
}

/// A variable a command may get: any POSIX env name.
fn valid_var(var: &str) -> bool {
    !var.is_empty()
        && var.len() <= 128
        && var.chars().next().is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && var.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}

fn name_arg(name: &str) -> Result<String, UsageError> {
    if valid_name(name) {
        Ok(name.to_owned())
    } else {
        Err(UsageError::new(format!(
            "{name:?} is not a key name: upper case letters, digits and _, starting with a letter or _ (at most 80)"
        )))
    }
}

/// `example.com,api.example.com`: lower case DNS names, each at most 253.
fn parse_hosts(text: &str) -> Result<Vec<String>, UsageError> {
    let mut hosts = Vec::new();
    for host in text.split(',').map(str::trim).filter(|h| !h.is_empty()) {
        let host = host.to_ascii_lowercase();
        let ok = host.len() <= 253
            && host.split('.').all(|label| {
                !label.is_empty()
                    && label.len() <= 63
                    && label.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
            });
        if !ok {
            return Err(UsageError::new(format!("--hosts: {host:?} is not a host name")));
        }
        if !hosts.contains(&host) {
            hosts.push(host);
        }
    }
    if hosts.is_empty() || hosts.len() > 16 {
        return Err(UsageError::new("--hosts takes 1 to 16 host names, comma separated"));
    }
    Ok(hosts)
}

fn parse_duration(flag: &str, text: &str, max: Duration) -> Result<Duration, UsageError> {
    let bad = || UsageError::new(format!("{flag} {text:?}: expected a number and d, h or m"));
    let (number, unit) = text.split_at(text.len().saturating_sub(1));
    let n: u64 = number.parse().map_err(|_| bad())?;
    let seconds = match unit {
        "d" => n.checked_mul(86_400),
        "h" => n.checked_mul(3_600),
        "m" => n.checked_mul(60),
        _ => None,
    }
    .ok_or_else(bad)?;
    let duration = Duration::from_secs(seconds);
    if duration.is_zero() || duration > max {
        return Err(bad());
    }
    Ok(duration)
}

/// The flags every way of storing a key shares; `extra` takes the verb's own (true when taken).
fn parse_put(
    name: &str,
    flags: &[String],
    mut extra: impl FnMut(&str, &mut dyn FnMut() -> Result<String, UsageError>) -> Result<bool, UsageError>,
) -> Result<Put, UsageError> {
    let mut put = Put {
        name: name_arg(name)?,
        purpose: None,
        hosts: Vec::new(),
        ttl: None,
        replace: false,
        asked_by: None,
        from_person: false,
    };
    let mut it = flags.iter();
    while let Some(flag) = it.next() {
        let mut value =
            || it.next().cloned().ok_or_else(|| UsageError::new(format!("{flag} needs a value")));
        match flag.as_str() {
            "--purpose" => {
                let text = value()?;
                if text.trim().is_empty() || text.chars().count() > MAX_PURPOSE_CHARS {
                    return Err(UsageError::new(format!(
                        "--purpose is 1 to {MAX_PURPOSE_CHARS} characters"
                    )));
                }
                put.purpose = Some(text.trim().to_owned());
            }
            "--hosts" => put.hosts = parse_hosts(&value()?)?,
            "--ttl" => put.ttl = Some(super::parse_ttl(&value()?)?),
            "--replace" => put.replace = true,
            // Explicit spelling of the default: the value comes on stdin.
            "--from-stdin" => {}
            "--from-person" => put.from_person = true,
            "--asked-by" => {
                let text = value()?;
                if text.is_empty() || text.len() > 200 {
                    return Err(UsageError::new("--asked-by is 1 to 200 bytes"));
                }
                put.asked_by = Some(text);
            }
            other => {
                if !extra(other, &mut value)? {
                    return Err(UsageError::new(format!(
                        "unknown flag {other:?}\nusage: {USAGE}"
                    )));
                }
            }
        }
    }
    Ok(put)
}

/// A `write` target.
fn parse_target(spec: &str) -> Result<Target, UsageError> {
    let file_and_path = |rest: &str, what: &str| -> Result<(PathBuf, String), UsageError> {
        let (file, field) = rest.rsplit_once('#').ok_or_else(|| {
            UsageError::new(format!("--to {spec:?}: expected {what}:PATH#FIELD"))
        })?;
        if file.is_empty() || field.is_empty() {
            return Err(UsageError::new(format!("--to {spec:?}: expected {what}:PATH#FIELD")));
        }
        Ok((absolute(file), field.to_owned()))
    };
    let dotted = |field: &str| -> Result<Vec<String>, UsageError> {
        let parts: Vec<String> = field.split('.').map(str::to_owned).collect();
        if parts.iter().any(String::is_empty) || parts.len() > 16 {
            return Err(UsageError::new(format!("--to {spec:?}: a field is a.b.c")));
        }
        Ok(parts)
    };
    if let Some(path) = spec.strip_prefix("file:") {
        if path.is_empty() {
            return Err(UsageError::new("--to file:PATH needs a path"));
        }
        return Ok(Target::File(absolute(path)));
    }
    if let Some(rest) = spec.strip_prefix("json:") {
        let (file, field) = file_and_path(rest, "json")?;
        return Ok(Target::Json(file, dotted(&field)?));
    }
    if let Some(rest) = spec.strip_prefix("toml:") {
        let (file, field) = file_and_path(rest, "toml")?;
        return Ok(Target::Toml(file, dotted(&field)?));
    }
    if let Some(rest) = spec.strip_prefix("env-file:") {
        let (file, var) = file_and_path(rest, "env-file")?;
        if !valid_var(&var) {
            return Err(UsageError::new(format!("--to {spec:?}: {var:?} is not an env name")));
        }
        return Ok(Target::EnvFile(file, var));
    }
    Store::parse(spec).map(Target::Store).map_err(|_| {
        UsageError::new(format!(
            "--to {spec:?}: expected gh-secret:OWNER/REPO[@ENV]:SECRET, keychain:[OWNER/REPO:]SECRET, vault:VAR, file:PATH, json:PATH#a.b, toml:PATH#a.b or env-file:PATH#VAR"
        ))
    })
}

fn absolute(path: &str) -> PathBuf {
    let path = Path::new(path);
    if let Some(rest) = path.to_str().and_then(|p| p.strip_prefix("~/"))
        && let Some(home) = std::env::var_os("HOME")
    {
        return PathBuf::from(home).join(rest);
    }
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir().map(|dir| dir.join(path)).unwrap_or_else(|_| path.to_path_buf())
    }
}

/// `Some` when `verb` is one of this module's.
pub(super) fn parse(verb: &str, rest: &[String]) -> Option<Result<Local, UsageError>> {
    let usage = || UsageError::new(format!("usage: {USAGE}"));
    Some(match (verb, rest) {
        ("put", [name, flags @ ..]) => parse_put(name, flags, |_, _| Ok(false)).map(Local::Put),
        ("generate", [name, flags @ ..]) => {
            let mut bytes = 32;
            let mut format = Format::Base64Url;
            parse_put(name, flags, |flag, value| {
                match flag {
                    "--bytes" => {
                        bytes = value()?
                            .parse()
                            .ok()
                            .filter(|n| (16..=256).contains(n))
                            .ok_or_else(|| UsageError::new("--bytes is 16 to 256"))?;
                    }
                    "--format" => {
                        format = match value()?.as_str() {
                            "base64url" => Format::Base64Url,
                            "hex" => Format::Hex,
                            "alnum" => Format::Alnum,
                            other => {
                                return Err(UsageError::new(format!(
                                    "--format {other:?}: base64url, hex or alnum"
                                )));
                            }
                        }
                    }
                    _ => return Ok(false),
                }
                Ok(true)
            })
            .and_then(|put| {
                if put.from_person {
                    return Err(UsageError::new("a generated key is not from a person"));
                }
                Ok(Local::Generate { put, bytes, format })
            })
        }
        ("request", [name, flags @ ..]) => {
            let mut timeout = DEFAULT_REQUEST_TIMEOUT;
            parse_put(name, flags, |flag, value| {
                if flag != "--timeout" {
                    return Ok(false);
                }
                timeout = parse_duration("--timeout", &value()?, MAX_REQUEST_TIMEOUT)?;
                Ok(true)
            })
            .and_then(|put| {
                if put.purpose.is_none() {
                    return Err(UsageError::new(
                        "request needs --purpose: the person sees it and decides by it",
                    ));
                }
                if put.from_person || put.asked_by.is_some() {
                    return Err(UsageError::new("--from-person and --asked-by are the app's own"));
                }
                Ok(Local::Request { put, timeout })
            })
        }
        ("use" | "run", args) => parse_use(args).map(Local::Use),
        ("write", [name, flags @ ..]) => (|| {
            let name = name_arg(name)?;
            let mut targets = Vec::new();
            let mut it = flags.iter();
            while let Some(flag) = it.next() {
                match flag.as_str() {
                    "--to" | "--store" => {
                        let spec = it
                            .next()
                            .ok_or_else(|| UsageError::new(format!("{flag} needs a target")))?;
                        targets.push(parse_target(spec)?);
                    }
                    other => {
                        return Err(UsageError::new(format!("unknown flag {other:?}\nusage: {USAGE}")));
                    }
                }
            }
            if targets.is_empty() {
                return Err(UsageError::new("write needs at least one --to TARGET"));
            }
            Ok(Local::Write { name, targets })
        })(),
        ("fill", [name, flags @ ..]) => (|| {
            let mut fill = Fill { name: name_arg(name)?, tab: None, selector: String::new(), typing: false };
            let mut it = flags.iter();
            while let Some(flag) = it.next() {
                let mut value = || {
                    it.next().cloned().ok_or_else(|| UsageError::new(format!("{flag} needs a value")))
                };
                match flag.as_str() {
                    "--tab" | "--browser" => fill.tab = Some(value()?),
                    "--selector" => fill.selector = value()?,
                    "--type" => fill.typing = true,
                    "--app" => {
                        return Err(UsageError::new(
                            "filling a desktop app goes through Computer Use: call the keys_fill tool of cmux's MCP server (in a cmux chat) with target app",
                        ));
                    }
                    other => {
                        return Err(UsageError::new(format!("unknown flag {other:?}\nusage: {USAGE}")));
                    }
                }
            }
            if fill.selector.is_empty() {
                return Err(UsageError::new("fill needs --selector CSS (or a snapshot ref like e3)"));
            }
            Ok(Local::Fill(fill))
        })(),
        ("put" | "generate" | "request" | "write" | "fill", []) => Err(usage()),
        _ => return None,
    })
}

fn parse_use(args: &[String]) -> Result<Use, UsageError> {
    let split = args
        .iter()
        .position(|a| a == "--")
        .ok_or_else(|| UsageError::new("use needs -- before the command: cmux keys use NAME -- CMD"))?;
    let (spec, argv) = (&args[..split], &args[split + 1..]);
    if argv.is_empty() {
        return Err(UsageError::new("use needs a command after --"));
    }
    let mut keys: Vec<(String, String)> = Vec::new();
    let mut mask = true;
    let mut it = spec.iter();
    while let Some(word) = it.next() {
        match word.as_str() {
            "--no-mask" => mask = false,
            "--env" | "--as" => {
                let var = it.next().ok_or_else(|| UsageError::new("--env needs a VAR"))?;
                let last = keys
                    .last_mut()
                    .ok_or_else(|| UsageError::new("--env VAR follows the key it names"))?;
                if !valid_var(var) {
                    return Err(UsageError::new(format!("{var:?} is not an env name")));
                }
                last.1 = var.clone();
            }
            other if other.starts_with('-') => {
                return Err(UsageError::new(format!("unknown flag {other:?}\nusage: {USAGE}")));
            }
            other => {
                let (name, var) = other.split_once('=').unwrap_or((other, other));
                let name = name_arg(name)?;
                if !valid_var(var) {
                    return Err(UsageError::new(format!("{var:?} is not an env name")));
                }
                keys.push((name, var.to_owned()));
            }
        }
    }
    if keys.is_empty() {
        return Err(UsageError::new("use needs at least one key: cmux keys use NAME -- CMD"));
    }
    let mut vars: Vec<&str> = keys.iter().map(|(_, v)| v.as_str()).collect();
    vars.sort_unstable();
    if vars.windows(2).any(|w| w[0] == w[1]) {
        return Err(UsageError::new("two keys go into one env var"));
    }
    Ok(Use { keys, mask, argv: argv.to_vec() })
}

/// The OS secret store. A trait so tests keep values in a map.
pub(in crate::cli) trait KeyVault {
    fn put(&self, item: &str, value: &str) -> Result<(), String>;
    fn get(&self, item: &str) -> Result<Option<Zeroizing<String>>, String>;
    fn delete(&self, item: &str) -> Result<(), String>;
}

/// The machine vault's OS store (`acpmux::vault::store::OsStore`): the login Keychain or the
/// Secret Service.
pub(in crate::cli) struct OsVault;

impl OsVault {
    fn store() -> Result<acpmux::vault::store::OsStore, String> {
        use acpmux::vault::store::SecretStore as _;
        let store = acpmux::vault::store::OsStore;
        if !store.available() {
            return Err("this machine has no OS secret store (a Mac's login Keychain, or the Secret Service with secret-tool on Linux): cmux keys keeps values nowhere else".into());
        }
        Ok(store)
    }
}

impl KeyVault for OsVault {
    fn put(&self, item: &str, value: &str) -> Result<(), String> {
        use acpmux::vault::store::SecretStore as _;
        Self::store()?.put(item, value).map_err(|code| format!("the OS secret store refused: {code}"))
    }
    fn get(&self, item: &str) -> Result<Option<Zeroizing<String>>, String> {
        use acpmux::vault::store::SecretStore as _;
        Self::store()?.get(item).map_err(|code| format!("the OS secret store refused: {code}"))
    }
    fn delete(&self, item: &str) -> Result<(), String> {
        use acpmux::vault::store::SecretStore as _;
        Self::store()?.delete(item).map_err(|code| format!("the OS secret store refused: {code}"))
    }
}

/// The running cmux app's control socket. A trait so tests answer for the app.
pub(in crate::cli) trait App {
    /// `deadline: None` answers within the control plane's read timeout.
    fn call(
        &self,
        method: &str,
        params: Value,
        deadline: Option<Instant>,
    ) -> Result<Result<Value, Value>, String>;
}

pub(in crate::cli) struct LiveApp<'a>(pub &'a crate::cli::GlobalArgs);

impl App for LiveApp<'_> {
    fn call(
        &self,
        method: &str,
        params: Value,
        deadline: Option<Instant>,
    ) -> Result<Result<Value, Value>, String> {
        let mut stream = crate::cli::app::connect_command(self.0).map_err(|error| {
            error
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("the cmux app is not reachable")
                .to_owned()
        })?;
        match deadline {
            Some(deadline) => {
                crate::cli::app::request_by(&mut stream, method, params, None, Some(deadline))
            }
            None => crate::cli::app::request(
                &mut stream,
                method,
                params,
                crate::cli::app::READ_TIMEOUT,
            ),
        }
    }
}

fn check_value(value: &str) -> Result<(), String> {
    if value.chars().count() < MIN_VALUE_CHARS {
        return Err(format!(
            "the value is shorter than {MIN_VALUE_CHARS} characters: a key that short is not one, and masking it would garble output"
        ));
    }
    if value.len() > MAX_VALUE_BYTES {
        return Err(format!("the value is longer than {} KiB", MAX_VALUE_BYTES / 1024));
    }
    if value.contains('\0') {
        return Err("the value has a NUL byte: no env var or field can carry it".into());
    }
    Ok(())
}

/// A random value from the OS random source.
fn generate(bytes: usize, format: Format) -> Result<Zeroizing<String>, String> {
    use base64::Engine as _;
    let mut raw = Zeroizing::new(vec![0u8; bytes]);
    getrandom::fill(&mut raw[..]).map_err(|e| format!("the OS random source failed: {e}"))?;
    Ok(Zeroizing::new(match format {
        Format::Base64Url => base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(&*raw),
        Format::Hex => raw.iter().map(|b| format!("{b:02x}")).collect(),
        Format::Alnum => {
            // Rejection sampling: 62 symbols, so bytes of 248 and up are drawn again (no bias).
            const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
            let mut out = String::with_capacity(bytes);
            let mut pool = Zeroizing::new(vec![0u8; 64]);
            while out.len() < bytes {
                getrandom::fill(&mut pool[..]).map_err(|e| format!("the OS random source failed: {e}"))?;
                for &b in pool.iter().filter(|&&b| b < 248) {
                    if out.len() == bytes {
                        break;
                    }
                    out.push(ALPHABET[usize::from(b % 62)] as char);
                }
            }
            out
        }
    }))
}

fn is_local(record: &Value) -> bool {
    record.get("provider").and_then(Value::as_str) == Some("local")
}

/// The record's state now: `revoked`, `expired` or `live`.
pub(super) fn state(record: &Value, now: u64) -> &'static str {
    if record.get("revoked_at").is_some_and(|v| !v.is_null()) {
        "revoked"
    } else if record.get("expires_at_s").and_then(Value::as_u64).is_some_and(|at| at <= now) {
        "expired"
    } else {
        "live"
    }
}

/// What `ls` adds to every record so a list (the CLI's, Settings > Keys) reads them all alike.
pub(super) fn listed(record: &mut Value, now: u64) {
    let state = state(record, now);
    let Some(fields) = record.as_object_mut() else { return };
    fields.insert("state".into(), json!(state));
    if !fields.contains_key("label") {
        let label = match (fields.get("kind").and_then(Value::as_str), fields.get("name")) {
            (Some("r2"), _) => format!(
                "R2 {} ({})",
                fields.get("bucket").and_then(Value::as_str).unwrap_or("?"),
                fields.get("access").and_then(Value::as_str).unwrap_or("?")
            ),
            (_, Some(Value::String(name))) => name.clone(),
            _ => fields.get("id").and_then(Value::as_str).unwrap_or("?").to_owned(),
        };
        fields.insert("label".into(), json!(label));
    }
    for (key, default) in [
        ("source", json!(fields.get("provider").cloned().unwrap_or(Value::Null))),
        ("purpose", Value::Null),
        ("hosts", json!([])),
        ("stores", json!([])),
        ("uses", json!([])),
        ("asked_by", Value::Null),
        ("expires_at", Value::Null),
    ] {
        fields.entry(key).or_insert(default);
    }
}

fn find_local<'a>(audit: &'a mut Value, name: &str) -> Option<&'a mut Value> {
    audit["keys"]
        .as_array_mut()?
        .iter_mut()
        .find(|k| is_local(k) && k.get("name").and_then(Value::as_str) == Some(name))
}

/// Stores `value` under `put.name` and records it. `source`: stdin, generated or person.
fn store(
    paths: &Paths,
    vault: &dyn KeyVault,
    put: &Put,
    value: &str,
    source: &str,
) -> Result<Value, String> {
    check_value(value)?;
    let _lock = AuditLock::take(&paths.audit)?;
    let mut audit = read_audit(&paths.audit)?;
    let now = now_secs();
    if let Some(old) = find_local(&mut audit, &put.name)
        && state(old, now) == "live"
        && !put.replace
    {
        return Err(format!(
            "a key {} is already stored: give --replace to store a new value under that name, or pick another name",
            put.name
        ));
    }
    vault.put(&item(&put.name), value)?;
    let expires = put.ttl.map(|ttl| now + ttl.as_secs());
    let mut record = json!({
        "id": put.name,
        "name": put.name,
        "label": put.name,
        "provider": "local",
        "kind": "secret",
        "source": source,
        "purpose": put.purpose,
        "hosts": put.hosts,
        "created_at": rfc3339(now),
        "expires_at": expires.map(rfc3339),
        "expires_at_s": expires,
        "stores": [],
        "uses": [],
        "by": requester(),
        "asked_by": put.asked_by,
        "revoked_at": Value::Null,
    });
    let keys = audit["keys"].as_array_mut().ok_or("bad audit")?;
    if let Some(index) = keys
        .iter()
        .position(|k| is_local(k) && k.get("name").and_then(Value::as_str) == Some(&put.name))
    {
        // A new value: copies written from the old one are listed until written again.
        let old = keys.remove(index);
        record["replaced_at"] = json!(rfc3339(now));
        record["stale_stores"] = old.get("stores").cloned().unwrap_or(json!([]));
    }
    keys.push(record.clone());
    write_audit(&paths.audit, &audit)
        .map_err(|e| format!("{} is stored, but the audit was not written: {e}", put.name))?;
    listed(&mut record, now);
    Ok(record)
}

/// The live record and value of key `name`.
pub(in crate::cli) fn value_of(
    paths: &Paths,
    vault: &dyn KeyVault,
    name: &str,
) -> Result<(Value, Zeroizing<String>), String> {
    let mut audit = read_audit(&paths.audit)?;
    let record = find_local(&mut audit, name)
        .ok_or_else(|| format!("no key {name}: cmux keys put {name} (value on stdin), or cmux keys request {name} --purpose TEXT"))?
        .clone();
    match state(&record, now_secs()) {
        "revoked" => return Err(format!("key {name} was removed: put it again")),
        "expired" => {
            return Err(format!(
                "key {name} expired at {}: store a fresh value with cmux keys put {name} --replace",
                record["expires_at"].as_str().unwrap_or("?")
            ));
        }
        _ => {}
    }
    let value = vault.get(&item(name))?.ok_or_else(|| {
        format!("key {name} is in the audit but its value is gone from the OS secret store: put it again with --replace")
    })?;
    Ok((record, value))
}

/// Notes that key `name` was entered at `target` (`uses`), or copied there (`stores`).
pub(in crate::cli) fn record(paths: &Paths, name: &str, target: &str, copy: bool) -> Result<(), String> {
    let _lock = AuditLock::take(&paths.audit)?;
    let mut audit = read_audit(&paths.audit)?;
    let now = now_secs();
    let Some(key) = find_local(&mut audit, name) else { return Ok(()) };
    if copy {
        let stores = key["stores"].as_array_mut().ok_or("bad audit record")?;
        if !stores.iter().any(|s| s == target) {
            stores.push(json!(target));
        }
        if let Some(stale) = key.get_mut("stale_stores").and_then(Value::as_array_mut) {
            stale.retain(|s| s != target);
        }
    }
    if !key.get("uses").is_some_and(Value::is_array) {
        key["uses"] = json!([]);
    }
    let uses = key["uses"].as_array_mut().ok_or("bad audit record")?;
    match uses.iter_mut().find(|u| u["target"] == target) {
        Some(found) => {
            found["count"] = json!(found["count"].as_u64().unwrap_or(0) + 1);
            found["last_used_at"] = json!(rfc3339(now));
            found["by"] = json!(requester());
        }
        None => uses.push(json!({"target": target, "count": 1, "last_used_at": rfc3339(now), "by": requester()})),
    }
    if uses.len() > MAX_USES {
        uses.sort_by(|a, b| b["last_used_at"].as_str().cmp(&a["last_used_at"].as_str()));
        uses.truncate(MAX_USES);
    }
    write_audit(&paths.audit, &audit)
}

/// Removes key `name`: its value leaves the OS store; the record stays, as revoked.
pub(super) fn revoke(paths: &Paths, vault: &dyn KeyVault, name: &str) -> Result<Value, String> {
    let _lock = AuditLock::take(&paths.audit)?;
    let mut audit = read_audit(&paths.audit)?;
    let key = find_local(&mut audit, name).ok_or_else(|| format!("no key {name} (cmux keys ls)"))?;
    vault.delete(&item(name))?;
    key["revoked_at"] = json!(rfc3339(now_secs()));
    let stores = key["stores"].clone();
    write_audit(&paths.audit, &audit)?;
    Ok(json!({
        "removed": name,
        "copies_still_live": stores,
        "next": "the copies under copies_still_live hold the value still: rotate it at its provider",
    }))
}

/// Replaces every occurrence of `values` in `text` with [`MASK`].
pub(in crate::cli) fn mask_text(text: &str, values: &[&str]) -> String {
    let mut out = text.to_owned();
    for value in values.iter().filter(|v| !v.is_empty()) {
        out = out.replace(value, MASK);
    }
    out
}

/// `value` with every string in it masked, keys included.
pub(in crate::cli) fn mask_json(value: &Value, secrets: &[&str]) -> Value {
    match value {
        Value::String(text) => Value::String(mask_text(text, secrets)),
        Value::Array(items) => Value::Array(items.iter().map(|v| mask_json(v, secrets)).collect()),
        Value::Object(fields) => Value::Object(
            fields.iter().map(|(k, v)| (mask_text(k, secrets), mask_json(v, secrets))).collect(),
        ),
        other => other.clone(),
    }
}

/// Masks values in a byte stream that arrives in pieces: it holds back the last bytes that could
/// start a value until the next piece shows whether they do.
pub(in crate::cli) struct Masker {
    needles: Vec<Zeroizing<Vec<u8>>>,
    keep: usize,
    pending: Zeroizing<Vec<u8>>,
}

impl Masker {
    pub(in crate::cli) fn new(values: &[&str]) -> Self {
        let mut needles: Vec<Zeroizing<Vec<u8>>> = values
            .iter()
            .filter(|v| !v.is_empty())
            .map(|v| Zeroizing::new(v.as_bytes().to_vec()))
            .collect();
        // Longest first, so a value that contains another masks whole.
        needles.sort_by_key(|n| std::cmp::Reverse(n.len()));
        let keep = needles.first().map_or(0, |n| n.len() - 1);
        Self { needles, keep, pending: Zeroizing::new(Vec::new()) }
    }

    /// The bytes of `piece` (after what came before) that are safe to print now.
    pub(in crate::cli) fn push(&mut self, piece: &[u8]) -> Vec<u8> {
        self.pending.extend_from_slice(piece);
        let mut out = Vec::with_capacity(self.pending.len());
        let mut i = 0;
        // Only a start that leaves `keep` bytes after it can be decided now.
        let decidable = self.pending.len().saturating_sub(self.keep);
        while i < decidable {
            if let Some(len) = self.match_at(i) {
                out.extend_from_slice(MASK.as_bytes());
                i += len;
            } else {
                out.push(self.pending[i]);
                i += 1;
            }
        }
        let rest = self.pending[i.min(self.pending.len())..].to_vec();
        self.pending = Zeroizing::new(rest);
        out
    }

    /// What is left at the end of the stream.
    pub(in crate::cli) fn finish(&mut self) -> Vec<u8> {
        let mut out = Vec::new();
        let mut i = 0;
        while i < self.pending.len() {
            if let Some(len) = self.match_at(i) {
                out.extend_from_slice(MASK.as_bytes());
                i += len;
            } else {
                out.push(self.pending[i]);
                i += 1;
            }
        }
        self.pending = Zeroizing::new(Vec::new());
        out
    }

    fn match_at(&self, i: usize) -> Option<usize> {
        let rest = &self.pending[i..];
        self.needles.iter().find(|n| rest.starts_with(n)).map(|n| n.len())
    }
}

/// Copies `from` to `to` through a [`Masker`] until the end.
fn pump(mut from: impl std::io::Read, mut to: impl std::io::Write, values: &[&str]) {
    let mut masker = Masker::new(values);
    let mut buf = Zeroizing::new(vec![0u8; 16 * 1024]);
    loop {
        match from.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                let out = masker.push(&buf[..n]);
                if to.write_all(&out).and_then(|()| to.flush()).is_err() {
                    break;
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
            Err(_) => break,
        }
    }
    let _ = to.write_all(&masker.finish());
    let _ = to.flush();
}

/// Runs `run.argv` with each key's value in its env var, stdin passed through, and (unless
/// `--no-mask`) every value masked in what it prints. The command's exit code, or 128 plus its
/// signal.
pub(in crate::cli) fn run_use(
    paths: &Paths,
    vault: &dyn KeyVault,
    run: &Use,
    stdout: impl std::io::Write + Send + 'static,
    stderr: impl std::io::Write + Send + 'static,
) -> Result<i32, String> {
    let mut values = Vec::new();
    for (name, var) in &run.keys {
        let (_, value) = value_of(paths, vault, name)?;
        values.push((name.clone(), var.clone(), value));
    }
    let program = Path::new(&run.argv[0])
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("command")
        .to_owned();
    for (name, var, _) in &values {
        record(paths, name, &format!("env:{var} for {program}"), false)?;
    }
    let mut command = cmux_process::Command::new(&run.argv[0]);
    command.args(&run.argv[1..]);
    for (_, var, value) in &values {
        command.env(var, value.as_str());
    }
    if !run.mask {
        command.stdin(cmux_process::Stdio::inherit());
        let mut child =
            command.spawn().map_err(|e| format!("cannot run {}: {e}", run.argv[0]))?;
        drop(values);
        return child.wait().map(exit_code).map_err(|e| e.to_string());
    }
    command
        .stdin(cmux_process::Stdio::inherit())
        .stdout(cmux_process::Stdio::piped())
        .stderr(cmux_process::Stdio::piped());
    let mut child = command.spawn().map_err(|e| format!("cannot run {}: {e}", run.argv[0]))?;
    let secrets: Vec<Zeroizing<String>> = values.into_iter().map(|(_, _, v)| v).collect();
    let out = child.stdout.take();
    let err = child.stderr.take();
    let threads = std::thread::scope(|scope| {
        let refs: Vec<&str> = secrets.iter().map(|s| s.as_str()).collect();
        let a = out.map(|pipe| {
            let refs = refs.clone();
            scope.spawn(move || pump(pipe, stdout, &refs))
        });
        let b = err.map(|pipe| {
            let refs = refs.clone();
            scope.spawn(move || pump(pipe, stderr, &refs))
        });
        let status = child.wait();
        for handle in [a, b].into_iter().flatten() {
            let _ = handle.join();
        }
        status
    });
    drop(secrets);
    threads.map(exit_code).map_err(|e| e.to_string())
}

fn exit_code(status: cmux_process::ExitStatus) -> i32 {
    use std::os::unix::process::ExitStatusExt as _;
    status.code().unwrap_or_else(|| 128 + status.signal().unwrap_or(0))
}

/// Writes `bytes` to `path` as a new 0600 file, through a temporary file and a rename, so a
/// reader sees the old file or the new one. A symlink or folder at `path` is refused: the value
/// would land somewhere the agent did not name.
fn write_private(path: &Path, bytes: &[u8]) -> Result<(), String> {
    use std::os::unix::fs::OpenOptionsExt as _;
    if let Ok(meta) = std::fs::symlink_metadata(path)
        && !meta.file_type().is_file()
    {
        return Err(format!("{} is not a plain file (a link or a folder): not written", path.display()));
    }
    let folder = path.parent().ok_or_else(|| format!("{} has no folder", path.display()))?;
    std::fs::create_dir_all(folder).map_err(|e| format!("cannot make {}: {e}", folder.display()))?;
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("key");
    let temporary = folder.join(format!(".{name}.cmux-keys.{}", std::process::id()));
    let _ = std::fs::remove_file(&temporary);
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&temporary)
        .map_err(|e| format!("cannot write {}: {e}", path.display()))?;
    let written = file.write_all(bytes).and_then(|()| file.sync_all());
    drop(file);
    if let Err(e) = written.and_then(|()| std::fs::rename(&temporary, path)) {
        let _ = std::fs::remove_file(&temporary);
        return Err(format!("cannot write {}: {e}", path.display()));
    }
    Ok(())
}

fn read_existing(path: &Path) -> Result<Option<Zeroizing<String>>, String> {
    match std::fs::File::open(path) {
        Ok(mut file) => {
            let mut text = Zeroizing::new(String::new());
            file.read_to_string(&mut text).map_err(|e| format!("cannot read {}: {e}", path.display()))?;
            Ok(Some(text))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("cannot read {}: {e}", path.display())),
    }
}

/// `text` (a JSON file, or none) with `field` set to `value`.
fn set_json(text: Option<&str>, field: &[String], value: &str) -> Result<Zeroizing<String>, String> {
    let mut root: Value = match text {
        Some(text) if !text.trim().is_empty() => {
            serde_json::from_str(text).map_err(|_| "the file is not JSON: not written".to_owned())?
        }
        _ => json!({}),
    };
    let mut at = &mut root;
    for part in field {
        if !at.is_object() {
            return Err(format!("{part:?}'s parent is not an object: not written"));
        }
        at = at.as_object_mut().expect("checked").entry(part.clone()).or_insert_with(|| json!({}));
    }
    *at = json!(value);
    let mut out = serde_json::to_string_pretty(&root).map_err(|e| e.to_string())?;
    out.push('\n');
    Ok(Zeroizing::new(out))
}

/// `text` (a TOML file, or none) with `field` set to `value`, every other line kept as it was.
fn set_toml(text: Option<&str>, field: &[String], value: &str) -> Result<Zeroizing<String>, String> {
    let mut doc: toml_edit::DocumentMut = text
        .unwrap_or("")
        .parse()
        .map_err(|_| "the file is not TOML: not written".to_owned())?;
    let (last, parents) = field.split_last().ok_or("no field")?;
    let mut table = doc.as_table_mut();
    for part in parents {
        let entry = table.entry(part).or_insert_with(|| toml_edit::Item::Table(toml_edit::Table::new()));
        table = entry
            .as_table_mut()
            .ok_or_else(|| format!("{part:?} is not a table: not written"))?;
    }
    table.insert(last, toml_edit::value(value));
    Ok(Zeroizing::new(doc.to_string()))
}

/// `text` (an env file, or none) with the line of `var` set to `value` (added when missing).
fn set_env_line(text: Option<&str>, var: &str, value: &str) -> Zeroizing<String> {
    let plain = value.chars().all(|c| c.is_ascii_alphanumeric() || "_-./+=:@,".contains(c));
    let quoted = if plain {
        value.to_owned()
    } else {
        let escaped = value
            .replace('\\', "\\\\")
            .replace('"', "\\\"")
            .replace('$', "\\$")
            .replace('`', "\\`")
            .replace('\n', "\\n");
        format!("\"{escaped}\"")
    };
    let line = format!("{var}={quoted}");
    let mut out = String::new();
    let mut found = false;
    for existing in text.unwrap_or("").lines() {
        let bare = existing.trim_start().strip_prefix("export ").unwrap_or(existing.trim_start());
        if bare.split_once('=').is_some_and(|(k, _)| k.trim() == var) {
            if !found {
                out.push_str(&line);
                out.push('\n');
            }
            found = true;
        } else {
            out.push_str(existing);
            out.push('\n');
        }
    }
    if !found {
        out.push_str(&line);
        out.push('\n');
    }
    Zeroizing::new(out)
}

/// The audit's name of a target.
fn target_label(target: &Target) -> String {
    match target {
        Target::Store(store) => store.spot(),
        Target::File(path) => format!("file:{}", path.display()),
        Target::Json(path, field) => format!("json:{}#{}", path.display(), field.join(".")),
        Target::Toml(path, field) => format!("toml:{}#{}", path.display(), field.join(".")),
        Target::EnvFile(path, var) => format!("env-file:{}#{var}", path.display()),
    }
}

/// Copies key `name` into each target, recording each; stops at the first that fails.
pub(in crate::cli) fn write(
    paths: &Paths,
    vault: &dyn KeyVault,
    sinks: &dyn Sinks,
    name: &str,
    targets: &[Target],
) -> Result<Value, String> {
    let (record, value) = value_of(paths, vault, name)?;
    let hosts: Vec<String> = record["hosts"]
        .as_array()
        .map(|h| h.iter().filter_map(Value::as_str).map(str::to_owned).collect())
        .unwrap_or_default();
    let mut written = Vec::new();
    for target in targets {
        let label = target_label(target);
        let outcome = match target {
            Target::Store(store) => {
                let store = store.clone().with_hosts(&hosts);
                sinks.put(&store, &store.name(""), &value)
            }
            Target::File(path) => write_private(path, value.as_bytes()),
            Target::Json(path, field) => read_existing(path)
                .and_then(|old| set_json(old.as_deref().map(|s| s.as_str()), field, &value))
                .and_then(|text| write_private(path, text.as_bytes())),
            Target::Toml(path, field) => read_existing(path)
                .and_then(|old| set_toml(old.as_deref().map(|s| s.as_str()), field, &value))
                .and_then(|text| write_private(path, text.as_bytes())),
            Target::EnvFile(path, var) => read_existing(path)
                .map(|old| set_env_line(old.as_deref().map(|s| s.as_str()), var, &value))
                .and_then(|text| write_private(path, text.as_bytes())),
        };
        if let Err(message) = outcome {
            return Err(format!(
                "{}\nwritten before it: {}",
                mask_text(&message, &[&value]),
                if written.is_empty() { "nothing".to_owned() } else { written.join(", ") }
            ));
        }
        record_copy(paths, name, &label)?;
        written.push(label);
    }
    Ok(json!({"key": name, "written": written}))
}

fn record_copy(paths: &Paths, name: &str, label: &str) -> Result<(), String> {
    record(paths, name, label, true)
}

/// The host of an `http(s)` URL, lower case.
fn url_host(url: &str) -> Option<String> {
    let rest = url.split_once("://").map(|(scheme, rest)| (scheme.to_ascii_lowercase(), rest))?;
    if rest.0 != "https" && rest.0 != "http" {
        return None;
    }
    let authority = rest.1.split(['/', '?', '#']).next()?;
    let host = authority.rsplit_once('@').map_or(authority, |(_, h)| h);
    let host = host.split(':').next()?;
    (!host.is_empty()).then(|| host.to_ascii_lowercase())
}

/// A page on `host` may get a key for `hosts`: the same host or a subdomain of one.
pub(in crate::cli) fn host_allowed(host: &str, hosts: &[String]) -> bool {
    hosts.iter().any(|allowed| host == allowed || host.ends_with(&format!(".{allowed}")))
}

/// Types key `name` into a field of a cmux browser tab. With hosts, a page on another host is
/// refused before anything is typed.
pub(in crate::cli) fn fill(
    paths: &Paths,
    vault: &dyn KeyVault,
    app: &dyn App,
    fill: &Fill,
) -> Result<Value, String> {
    let (record, value) = value_of(paths, vault, &fill.name)?;
    let hosts: Vec<String> = record["hosts"]
        .as_array()
        .map(|h| h.iter().filter_map(Value::as_str).map(str::to_owned).collect())
        .unwrap_or_default();
    let mut target = json!({});
    if let Some(tab) = &fill.tab {
        target["tab"] = json!(tab);
    }
    let state = app
        .call("browser.page.state", target.clone(), None)?
        .map_err(|error| refusal("browser.page.state", &error))?;
    let url = state.get("url").and_then(Value::as_str).unwrap_or("");
    let host = url_host(url);
    if !hosts.is_empty() {
        match &host {
            Some(host) if host_allowed(host, &hosts) => {}
            _ => {
                return Err(format!(
                    "key {} is for {}, and the tab shows {}: not filled",
                    fill.name,
                    hosts.join(", "),
                    host.as_deref().unwrap_or("no web page")
                ));
            }
        }
    }
    let mut params = target.clone();
    params["selector"] = json!(fill.selector);
    params["text"] = json!(value.as_str());
    params["secret"] = json!(true);
    params["secret_hosts"] = json!(hosts);
    let method = if fill.typing { "browser.page.type" } else { "browser.page.fill" };
    let answer = app.call(method, params, None)?;
    let answer = match answer {
        Ok(answer) => answer,
        Err(error) => return Err(mask_text(&refusal(method, &error), &[&value])),
    };
    let tab = answer.get("tab").or_else(|| state.get("tab")).cloned().unwrap_or(Value::Null);
    let place = format!("browser:{} {}", host.as_deref().unwrap_or("page"), fill.selector);
    record(paths, &fill.name, &place, false)?;
    Ok(mask_json(
        &json!({"filled": fill.name, "tab": tab, "host": host, "selector": fill.selector}),
        &[&value],
    ))
}

fn refusal(method: &str, error: &Value) -> String {
    format!(
        "{method}: {} {}",
        error.get("code").and_then(Value::as_str).unwrap_or("refused"),
        error.get("message").and_then(Value::as_str).unwrap_or("")
    )
}

/// Asks the person, in the cmux app, for key `put.name`; the app stores what they paste with
/// `cmux keys put --from-person` and answers once it is stored.
fn request(paths: &Paths, app: &dyn App, put: &Put, timeout: Duration) -> Result<Value, String> {
    let params = json!({
        "name": put.name,
        "purpose": put.purpose,
        "hosts": put.hosts,
        "ttl": put.ttl.map(|ttl| format!("{}m", ttl.as_secs() / 60)),
        "replace": put.replace,
        "requester": requester(),
    });
    let answer = app.call("keys.request", params, Some(Instant::now() + timeout))?;
    match answer {
        Ok(_) => {}
        Err(error) => {
            let code = error.get("code").and_then(Value::as_str).unwrap_or("");
            return Err(match code {
                "declined" => format!("the person declined to give {}", put.name),
                "cancelled" => format!("the ask for {} was replaced or cancelled", put.name),
                "timeout" => format!("no answer to the ask for {} within the timeout", put.name),
                "method_not_found" | "unknown_method" => {
                    "this cmux app has no key prompt yet: update cmux NEXT, or have the person run cmux keys put in a terminal".into()
                }
                _ => refusal("keys.request", &error),
            });
        }
    }
    let mut audit = read_audit(&paths.audit)?;
    let mut record = find_local(&mut audit, &put.name)
        .filter(|record| state(record, now_secs()) == "live")
        .cloned()
        .ok_or_else(|| format!("the app answered, but no live key {} is in the audit", put.name))?;
    listed(&mut record, now_secs());
    Ok(json!({"stored": record}))
}

/// Runs a command other than `use`.
pub(in crate::cli) fn run(
    command: Local,
    paths: &Paths,
    vault: &dyn KeyVault,
    sinks: &dyn Sinks,
    app: &dyn App,
    read: &dyn Fn(&str) -> Result<Zeroizing<String>, String>,
) -> Result<Value, String> {
    match command {
        Local::Put(put) => {
            let value = read(&put.name)?;
            let source = if put.from_person { "person" } else { "stdin" };
            store(paths, vault, &put, &value, source).map(|record| json!({"stored": record}))
        }
        Local::Generate { put, bytes, format } => {
            let value = generate(bytes, format)?;
            store(paths, vault, &put, &value, "generated").map(|record| json!({"stored": record}))
        }
        Local::Request { put, timeout } => request(paths, app, &put, timeout),
        Local::Write { name, targets } => write(paths, vault, sinks, &name, &targets),
        Local::Fill(spec) => fill(paths, vault, app, &spec),
        Local::Use(_) => Err("use runs a command: run_use".into()),
    }
}

#[cfg(test)]
#[path = "local_tests.rs"]
pub(in crate::cli) mod tests;
