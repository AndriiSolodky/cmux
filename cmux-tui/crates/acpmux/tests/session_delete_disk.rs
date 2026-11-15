//! A deleted chat leaves nothing of its own on disk, through a real daemon under load: 200 chats
//! made and deleted from 8 connections at once, some deleted the moment they exist, some mid-turn,
//! some after a turn that sent images, a PDF and a dropped file. After them the daemon's home, the
//! sessions' temporary folders and the project folder hold no file that is not there after one
//! chat was made and deleted, and no file names or holds any deleted chat's id.
//!
//! Leo asked us to "follow along with these things to fix/improve": a desktop agent app's deleted
//! sessions left transcripts, command output and temp files behind, also when deleted right after
//! they opened, until they filled the disk.
#![cfg(unix)]

#[path = "support/daemon_env.rs"]
mod daemon_env;
// This process runs stand-in agents (the fake agents under tests/).
const HERMETIC: daemon_env::Process = daemon_env::Process::stand_in();

use base64::Engine;
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::{Child, Stdio};
use std::time::{Duration, Instant};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt};

const FAKE: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fake_agent.py");
const CHATS: usize = 200;
const CONNECTIONS: usize = 8;

struct Daemon {
    child: Option<Child>,
    /// The scratch folder: the daemon's home, its sessions' temporary folders (`session-tmp`),
    /// the agents' HOME (`home`) and the chats' project folder (`p`).
    root: PathBuf,
    socket: PathBuf,
}

impl Daemon {
    fn start() -> Self {
        // Short: host sockets sit next to their records only under the `sun_path` limit.
        let root = std::env::temp_dir().join(format!("sdd-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("p")).unwrap();
        std::fs::write(
            root.join("config.json"),
            json!({
                "harnesses": {"fake": {"argv": ["python3", FAKE], "family": "codex"}},
                "defaultHarness": "fake",
                "permissionPolicy": "approve-all",
                "titles": {"generate": false},
            })
            .to_string(),
        )
        .unwrap();
        let socket = root.join("s.sock");
        let mut child = daemon_env::command(&root, daemon_env::Agents::StandIn, &[])
            .args(["daemon", "run", "--listen", "127.0.0.1:0", "--ready-fd", "1", "--log", "warn"])
            .env("ACPMUX_HOME", &root)
            .env("ACPMUX_SOCKET", &socket)
            .env("CMUX_NEXT_CONFIG_FILE", root.join("cmux-next.json"))
            .env("ACPMUX_CATALOG_FETCH", "0")
            .env("ACPMUX_LOGIN_ENV", "0")
            .env("ACPMUX_SPARE_HARNESS", "0")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .expect("start daemon");
        daemon_env::ready_line(child.stdout.take().unwrap());
        Self { child: Some(child), root, socket }
    }

    async fn rpc(&self) -> Rpc {
        let s = tokio::net::UnixStream::connect(&self.socket).await.expect("connect");
        let (rd, wr) = s.into_split();
        Rpc { lines: tokio::io::BufReader::new(rd).lines(), wr, next: 0 }
    }
}

impl Drop for Daemon {
    fn drop(&mut self) {
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
        // End every agent host this test's daemon started.
        let hosts = self.root.join("hosts");
        for entry in std::fs::read_dir(&hosts).into_iter().flatten().flatten() {
            let Ok(bytes) = std::fs::read(entry.path()) else { continue };
            let Ok(record) = serde_json::from_slice::<Value>(&bytes) else { continue };
            for pid in [record["harness_pid"].as_i64(), record["host_pid"].as_i64()] {
                if let Some(pid) = pid {
                    // SAFETY: process groups this test's daemon created.
                    unsafe { libc::killpg(pid as i32, libc::SIGKILL) };
                }
            }
        }
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

struct Rpc {
    lines: tokio::io::Lines<tokio::io::BufReader<tokio::net::unix::OwnedReadHalf>>,
    wr: tokio::net::unix::OwnedWriteHalf,
    next: i64,
}

impl Rpc {
    async fn send(&mut self, method: &str, params: Value) -> i64 {
        self.next += 1;
        let line = json!({"jsonrpc": "2.0", "id": self.next, "method": method, "params": params});
        self.wr.write_all(format!("{line}\n").as_bytes()).await.unwrap();
        self.next
    }

    async fn answer(&mut self, id: i64) -> Value {
        loop {
            let line = tokio::time::timeout(Duration::from_secs(60), self.lines.next_line())
                .await
                .expect("daemon answered in time")
                .unwrap()
                .expect("daemon closed the socket");
            let v: Value = serde_json::from_str(&line).unwrap();
            if v.get("id") == Some(&json!(id)) {
                return v;
            }
        }
    }

    async fn call(&mut self, method: &str, params: Value) -> Value {
        let id = self.send(method, params).await;
        let v = self.answer(id).await;
        assert!(v.get("error").is_none(), "{method} failed: {v}");
        v["result"].clone()
    }

    async fn new_chat(&mut self, cwd: &Path, name: &str) -> String {
        let made = self
            .call(
                "session/new",
                json!({"cwd": cwd, "mcpServers": [], "_meta": {"acpmux": {"name": name}}}),
            )
            .await;
        made["sessionId"].as_str().unwrap_or_else(|| panic!("{made}")).to_owned()
    }

    async fn delete(&mut self, id: &str) {
        self.call("_acpmux/kill", json!({"sessionId": id, "purge": true})).await;
    }
}

fn b64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

/// Bytes unique to chat `n` that read as a PNG (`prompt_images::sniffed_type`).
fn png(n: usize) -> Vec<u8> {
    let mut bytes = b"\x89PNG\r\n\x1a\n".to_vec();
    bytes.extend_from_slice(format!("chat {n}").as_bytes());
    bytes
}

/// One chat's life, by `n`: deleted at once, mid-turn, after a plain turn, or after a turn that
/// sent an image, a PDF and a dropped file.
async fn one_chat(rpc: &mut Rpc, cwd: &Path, n: usize) -> String {
    let id = rpc.new_chat(cwd, &format!("disk-{n}")).await;
    match n % 4 {
        0 => {}
        1 => {
            // Deleted while its turn runs (the fake waits for the cancel).
            rpc.send(
                "session/prompt",
                json!({"sessionId": id, "prompt": [{"type": "text", "text": "until-cancel"}]}),
            )
            .await;
        }
        2 => {
            rpc.call(
                "session/prompt",
                json!({"sessionId": id, "prompt": [{"type": "text", "text": format!("hi {n}")}]}),
            )
            .await;
        }
        _ => {
            let put = rpc
                .call(
                    "_acpmux/file_put",
                    json!({"sessionId": id, "fileName": "notes.txt", "data": b64(format!("notes {n}").as_bytes())}),
                )
                .await;
            assert!(put["path"].is_string(), "{put}");
            let pdf = format!("%PDF-1.4 chat {n}");
            rpc.call(
                "session/prompt",
                json!({"sessionId": id, "prompt": [
                    {"type": "text", "text": format!("look {n}")},
                    {"type": "image", "mimeType": "image/png", "data": b64(&png(n)), "name": "shot.png"},
                    {"type": "document", "mimeType": "application/pdf", "data": b64(pdf.as_bytes()), "name": "doc.pdf"},
                ]}),
            )
            .await;
        }
    }
    rpc.delete(&id).await;
    id
}

/// Every file and folder under `root` with its size (0 for a folder), by its path below `root`.
fn tree(root: &Path) -> BTreeMap<PathBuf, u64> {
    fn walk(root: &Path, dir: &Path, out: &mut BTreeMap<PathBuf, u64>) {
        for entry in std::fs::read_dir(dir).into_iter().flatten().flatten() {
            let path = entry.path();
            let Ok(kind) = entry.file_type() else { continue };
            let rel = path.strip_prefix(root).unwrap().to_owned();
            if kind.is_dir() {
                out.insert(rel, 0);
                walk(root, &path, out);
            } else {
                out.insert(rel, entry.metadata().map_or(0, |m| m.len()));
            }
        }
    }
    let mut out = BTreeMap::new();
    walk(root, root, &mut out);
    out
}

/// The paths under `root` that are not in `baseline`, or that name or hold one of `ids`.
fn leftovers(root: &Path, baseline: &BTreeMap<PathBuf, u64>, ids: &[String]) -> Vec<String> {
    let now = tree(root);
    let mut out = Vec::new();
    for (rel, size) in &now {
        let shown = rel.to_string_lossy();
        if let Some(id) = ids.iter().find(|id| shown.contains(id.as_str())) {
            out.push(format!("{shown} (names deleted chat {id})"));
            continue;
        }
        if !baseline.contains_key(rel) {
            out.push(format!("{shown} ({size} bytes, new since the baseline)"));
            continue;
        }
        // A file that keeps a deleted chat's id: an index row or a copy of its log.
        if *size > 0
            && let Ok(bytes) = std::fs::read(root.join(rel))
        {
            let text = String::from_utf8_lossy(&bytes);
            if let Some(id) = ids.iter().find(|id| text.contains(id.as_str())) {
                out.push(format!("{shown} (holds deleted chat {id})"));
            }
        }
    }
    out
}

/// The daemon's own log names sessions it served; it is bounded by its own rotation, not a
/// chat's file.
fn is_log(rel: &str) -> bool {
    rel.ends_with(".log") || rel.contains(".log.") || rel.starts_with("logs")
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn deleted_chats_leave_nothing_on_disk_under_load() {
    let daemon = Daemon::start();
    let root = daemon.root.clone();
    let cwd = root.join("p");
    // One chat of every kind made and deleted first: the folders and shared files a daemon
    // keeps for all its chats exist from then on.
    let mut rpc = daemon.rpc().await;
    let mut warm = Vec::new();
    for n in 0..4 {
        warm.push(one_chat(&mut rpc, &cwd, CHATS + n).await);
    }
    let settle = |ids: Vec<String>, baseline: BTreeMap<PathBuf, u64>| {
        let root = root.clone();
        async move {
            // The last deletes' background removals (moved-aside folders, hosts ending) finish
            // within a few seconds.
            let deadline = Instant::now() + Duration::from_secs(20);
            loop {
                let left: Vec<String> = leftovers(&root, &baseline, &ids)
                    .into_iter()
                    .filter(|l| !is_log(l))
                    .collect();
                if left.is_empty() || Instant::now() >= deadline {
                    return left;
                }
                tokio::time::sleep(Duration::from_millis(200)).await;
            }
        }
    };
    let empty = BTreeMap::new();
    // Only the id check against the warm-up chats (the baseline is not taken yet).
    let warm_left: Vec<String> = settle(warm.clone(), empty)
        .await
        .into_iter()
        .filter(|l| l.contains("deleted chat"))
        .collect();
    let baseline = tree(&root);
    let bytes_before: u64 = baseline.values().sum();
    let started = Instant::now();
    let mut workers = Vec::new();
    for w in 0..CONNECTIONS {
        let mut rpc = daemon.rpc().await;
        let cwd = cwd.clone();
        workers.push(tokio::spawn(async move {
            let mut ids = Vec::new();
            for n in (w..CHATS).step_by(CONNECTIONS) {
                ids.push(one_chat(&mut rpc, &cwd, n).await);
            }
            ids
        }));
    }
    let mut ids = warm.clone();
    for worker in workers {
        ids.extend(worker.await.unwrap());
    }
    let elapsed = started.elapsed();
    let left = settle(ids, baseline.clone()).await;
    let bytes_after: u64 = tree(&root).values().sum();
    println!(
        "session-delete-disk: {}",
        json!({"chats": CHATS, "secs": elapsed.as_secs_f64(), "bytes_before": bytes_before,
               "bytes_after": bytes_after, "leftovers": left.len() + warm_left.len()})
    );
    let mut all = warm_left;
    all.extend(left);
    assert!(
        all.is_empty(),
        "{} paths left by deleted chats:\n{}",
        all.len(),
        all.iter().take(60).cloned().collect::<Vec<_>>().join("\n")
    );
}
