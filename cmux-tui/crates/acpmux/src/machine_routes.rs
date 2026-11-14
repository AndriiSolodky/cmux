//! A route from this machine's app to each of the person's other machines' cmux-tui session
//! daemon, with no ssh: one local unix socket per machine the hub lists for this person
//! (`hub/mesh_book.rs`, the machines a sign-in, a pair code or a join line joined). The app opens
//! it as a server row's `unix` route (`ServerReach.Route.unix`), as it opens a server on this Mac,
//! and New Workspace on that row runs there.
//!
//! Each connection to a route's socket dials one hub carrier circuit naming the cmux-tui session
//! service ([`CircuitService::CmuxTuiSession`]) to that machine and carries its bytes both ways.
//! The far end admits it only while the person there granted "control for my other machines
//! signed in to this account" (`session_service.rs`); until then the circuit is refused with the
//! reason, the route's state says it, and the far machine's app asks once.
//!
//! Who reaches a route: its socket is in this daemon's own socket folder (owner only, the folder
//! the daemon's `acpmux.sock` is in), made 0600, and each accepted connection's peer must be this
//! user. That is the trust the local cmux-tui socket has: the person's own processes.
//!
//! Cost: one listener per listed machine (a person has a few) while the hub lists it; a circuit
//! exists only while a connection to its socket is open. A machine the book stops listing has
//! its listener and socket removed at the next read of the routes.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, Weak};

use serde_json::{Value, json};

use crate::hub::Hub;
use crate::hub_carrier::CircuitService;

/// The routes of one daemon, by hub `daemonId`.
#[derive(Default)]
pub struct Routes {
    routes: Mutex<BTreeMap<String, Route>>,
}

struct Route {
    host: String,
    socket: PathBuf,
    /// Why the last circuit was refused (`{reason, error}`), cleared by one that opened.
    last: Arc<Mutex<Option<Value>>>,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for Route {
    fn drop(&mut self) {
        self.task.abort();
        let _ = std::fs::remove_file(&self.socket);
    }
}

/// The socket of the route to the machine whose hub `daemonId` is `key`, beside `daemon_socket`
/// (this daemon's own `acpmux.sock`): a short name from the key's hash, so every path fits a
/// unix socket address the daemon's own does.
pub fn socket_for(daemon_socket: &Path, key: &str) -> PathBuf {
    let digest = crate::sha256::sha256_hex(key.as_bytes());
    let name = format!("acpmux-m-{}.sock", &digest[..12]);
    daemon_socket.with_file_name(name)
}

/// A carrier's refusal (`"MESSAGE (REASON)"`, `ServiceRefusal`'s text) as `{reason, error}`.
pub fn refusal_of(text: &str) -> Value {
    let parsed =
        text.strip_suffix(')').and_then(|rest| rest.rsplit_once(" (")).filter(|(_, reason)| {
            !reason.is_empty()
                && reason.chars().all(|c| c.is_ascii_alphanumeric() || "._".contains(c))
        });
    match parsed {
        Some((message, reason)) => json!({"reason": reason, "error": message}),
        None => json!({"reason": "machine.unreachable", "error": text}),
    }
}

impl Routes {
    /// Keep one route per machine of `machines` (`(daemonId, host)`), sockets beside
    /// `daemon_socket`, and drop the rest. A route that cannot bind is listed with its error.
    #[cfg(unix)]
    pub async fn reconcile(
        &self,
        hub: &Arc<Hub>,
        daemon_socket: &Path,
        machines: &[(String, String)],
    ) -> Vec<Value> {
        let wanted: BTreeMap<&str, &str> =
            machines.iter().map(|(k, h)| (k.as_str(), h.as_str())).collect();
        let stale: Vec<Route> = {
            let mut routes = self.routes.lock().unwrap_or_else(|e| e.into_inner());
            let gone: Vec<String> =
                routes.keys().filter(|k| !wanted.contains_key(k.as_str())).cloned().collect();
            gone.into_iter().filter_map(|k| routes.remove(&k)).collect()
        };
        drop(stale);
        let mut listed = Vec::new();
        for (key, host) in wanted {
            let known = {
                let mut routes = self.routes.lock().unwrap_or_else(|e| e.into_inner());
                // A machine that changed its host name keeps its route under the new name.
                if let Some(route) = routes.get_mut(key) {
                    route.host = host.to_owned();
                }
                routes
                    .get(key)
                    .map(|r| (r.socket.clone(), r.last.lock().ok().and_then(|l| l.clone())))
            };
            let (socket, last) = match known {
                Some(known) => known,
                None => {
                    let socket = socket_for(daemon_socket, key);
                    match crate::server::bind_unix(&socket).await {
                        Ok(listener) => {
                            let last = Arc::new(Mutex::new(None));
                            let task = tokio::spawn(serve(
                                Arc::downgrade(hub),
                                key.to_owned(),
                                listener,
                                last.clone(),
                            ));
                            let route =
                                Route { host: host.to_owned(), socket: socket.clone(), last, task };
                            self.routes
                                .lock()
                                .unwrap_or_else(|e| e.into_inner())
                                .insert(key.to_owned(), route);
                            (socket, None)
                        }
                        Err(e) => {
                            listed.push(json!({
                                "host": host, "daemonId": key, "via": "hub", "route": null,
                                "state": "unavailable",
                                "refusal": {"reason": "route.bind", "error": format!("{e:#}")},
                            }));
                            continue;
                        }
                    }
                }
            };
            let state = if last.is_some() { "refused" } else { "ready" };
            listed.push(json!({
                "host": host, "daemonId": key, "via": "hub", "route": "unix",
                "socket": socket, "state": state, "refusal": last,
            }));
        }
        listed
    }

    /// Every route, dropped (the daemon stops, or the carrier left with the join).
    pub fn clear(&self) {
        let all = std::mem::take(&mut *self.routes.lock().unwrap_or_else(|e| e.into_inner()));
        drop(all);
    }

    /// Record the outcome of a circuit to `key`: None when it opened, else its refusal.
    pub fn record(&self, key: &str, outcome: Option<Value>) {
        if let Some(route) = self.routes.lock().unwrap_or_else(|e| e.into_inner()).get(key)
            && let Ok(mut last) = route.last.lock()
        {
            *last = outcome;
        }
    }
}

/// Whether `stream`'s peer is this process's user.
#[cfg(unix)]
fn same_user(stream: &tokio::net::UnixStream) -> bool {
    // SAFETY: geteuid has no preconditions.
    stream.peer_cred().is_ok_and(|cred| cred.uid() == unsafe { libc::geteuid() })
}

/// Dial one session circuit to `key`: the stream, or the refusal as `{reason, error}`. Refused
/// by name when the carrier is off or the hub no longer lists the machine for this person.
pub async fn dial(hub: &Hub, key: &str) -> Result<crate::hub_carrier::HubStream, Value> {
    if hub.mesh_book_machine(key).is_none() {
        return Err(json!({
            "reason": "machine.unlisted",
            "error": "the hub no longer lists that machine for this account",
        }));
    }
    let carrier = hub.hub_carrier.get().ok_or_else(|| {
        json!({
            "reason": "carrier.off",
            "error": "this machine's hub carrier is off (not joined, or no WireGuard key)",
        })
    })?;
    carrier.dial_service(key, CircuitService::CmuxTuiSession).await.map_err(|e| refusal_of(&e))
}

#[cfg(unix)]
async fn serve(
    hub: Weak<Hub>,
    key: String,
    listener: tokio::net::UnixListener,
    last: Arc<Mutex<Option<Value>>>,
) {
    while let Ok((mut stream, _)) = listener.accept().await {
        if !same_user(&stream) {
            continue;
        }
        let Some(hub) = hub.upgrade() else { return };
        let key = key.clone();
        let last = last.clone();
        tokio::spawn(async move {
            match dial(&hub, &key).await {
                Ok(mut circuit) => {
                    if let Ok(mut l) = last.lock() {
                        *l = None;
                    }
                    drop(hub);
                    let _ = tokio::io::copy_bidirectional(&mut stream, &mut circuit).await;
                }
                Err(refusal) => {
                    tracing::info!(machine = %key, "a workspace route was refused: {refusal}");
                    if let Ok(mut l) = last.lock() {
                        *l = Some(refusal);
                    }
                }
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_refusal_reads_back_its_reason() {
        let refused = refusal_of("waiting for the person on that machine (consent_required)");
        assert_eq!(refused["reason"], "consent_required");
        assert_eq!(refused["error"], "waiting for the person on that machine");
        let odd = refusal_of("the machine closed the circuit before answering");
        assert_eq!(odd["reason"], "machine.unreachable");
    }

    #[test]
    fn a_route_socket_is_short_and_beside_the_daemons() {
        let daemon = Path::new("/tmp/acpmux-501/acpmux.sock");
        let socket = socket_for(daemon, "a2V5LW9mLW1hY2hpbmUtYg==");
        assert_eq!(socket.parent(), daemon.parent());
        assert!(socket.file_name().unwrap().len() <= 32);
        assert_ne!(socket, socket_for(daemon, "another-key"));
    }
}
