//! Terminal ports: the TCP ports the programs in a workspace's terminals
//! listen on show as the workspace's status entry `ports` (":3000, :5173"),
//! which the app's sidebar row and hover card already draw (CmuxNextBridge
//! `SidebarMapping.portsKey`). Every machine's daemon writes the entries of
//! its own workspaces, so a dev server started on another machine shows on
//! that machine's workspace in the app, the same as one on this Mac; a browser
//! tab in that workspace already reaches the machine's localhost.
//!
//! One thread scans every [`SCAN_INTERVAL`] while the mux lives. A scan reads
//! the terminals (pid and workspace) under the state lock, then everything
//! else outside it: on Linux the machine's LISTEN table first, and the
//! process trees and their sockets only when that table or the terminals
//! changed since the last scan, so a quiet machine costs two small file reads
//! per scan; on macOS the terminals' trees through libproc
//! (`cmux_tui_platform::listening_sockets`). It commits only a change.
//!
//! The daemon's entry carries the icon [`PORTS_ICON`]. A `ports` entry with
//! another icon (or none) is a person's or a hook's
//! (`cmux workspace status set ports ...`): the scan never replaces or clears
//! it. Entries an earlier daemon run left are reconciled by the first scan.

use std::collections::{BTreeMap, BTreeSet};

use super::*;
use crate::process_resources::Sampler;
use crate::state::WorkspaceStatusChange;
use crate::state::status_meta::StatusMeta;
use crate::workspace_registry::WorkspaceMutation;
use cmux_tui_platform::listening_sockets::Listeners;

/// The status key the sidebar's ports element reads.
pub(crate) const PORTS_KEY: &str = "ports";
/// Marks the entry as the daemon's.
pub(crate) const PORTS_ICON: &str = "network";
/// How often the terminals' listeners are read.
pub(crate) const SCAN_INTERVAL: Duration = Duration::from_secs(2);

/// One live terminal: its workspace's public id and its program's pid.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) struct TerminalProcess {
    pub(crate) workspace: String,
    pub(crate) pid: u32,
}

/// The ports each workspace's terminals listen on: every process in the tree
/// under each terminal's program counts.
pub(crate) fn workspace_ports(
    terminals: &[TerminalProcess],
    mut tree: impl FnMut(u32) -> Vec<u32>,
    mut ports_of: impl FnMut(u32) -> BTreeSet<u16>,
) -> BTreeMap<String, BTreeSet<u16>> {
    let mut out: BTreeMap<String, BTreeSet<u16>> = BTreeMap::new();
    for terminal in terminals {
        let ports: BTreeSet<u16> = tree(terminal.pid).into_iter().flat_map(&mut ports_of).collect();
        if !ports.is_empty() {
            out.entry(terminal.workspace.clone()).or_default().extend(ports);
        }
    }
    out
}

/// The entry's text, in the sidebar's documented form: ":3000, :5173".
pub(crate) fn ports_text(ports: &BTreeSet<u16>) -> String {
    ports.iter().map(|port| format!(":{port}")).collect::<Vec<_>>().join(", ")
}

/// One write the scan makes.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum PortsChange {
    Set { workspace: String, text: String },
    Clear { workspace: String },
}

/// A `ports` entry as stored: its text and icon.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct StoredPorts {
    pub(crate) text: String,
    pub(crate) icon: Option<String>,
}

/// The writes that make the stored entries of `live` workspaces match
/// `wanted`, touching only the daemon's own entries (icon [`PORTS_ICON`]).
pub(crate) fn plan(
    live: &BTreeSet<String>,
    stored: &BTreeMap<String, StoredPorts>,
    wanted: &BTreeMap<String, String>,
) -> Vec<PortsChange> {
    let ours = |entry: &StoredPorts| entry.icon.as_deref() == Some(PORTS_ICON);
    let mut changes = Vec::new();
    for workspace in live {
        let current = stored.get(workspace);
        match (wanted.get(workspace), current) {
            (Some(text), None) => {
                changes.push(PortsChange::Set { workspace: workspace.clone(), text: text.clone() })
            }
            (Some(text), Some(entry)) if ours(entry) && entry.text != *text => {
                changes.push(PortsChange::Set { workspace: workspace.clone(), text: text.clone() })
            }
            (None, Some(entry)) if ours(entry) => {
                changes.push(PortsChange::Clear { workspace: workspace.clone() })
            }
            _ => {}
        }
    }
    changes
}

/// What the last scan saw, to skip a scan whose inputs did not change.
#[derive(Default)]
pub(crate) struct ScanMemory {
    terminals: Vec<TerminalProcess>,
    /// The machine's LISTEN sockets (Linux); `None` reads every scan.
    listeners: Option<BTreeSet<u64>>,
    /// What the last scan wrote; `None` until the first reconcile.
    wanted: Option<BTreeMap<String, String>>,
}

/// Starts the scan thread. In-crate tests build many a `Mux` and drive
/// [`Mux::scan_terminal_ports`] themselves; `tests/terminal_ports.rs` runs
/// the thread through `Mux::new`.
pub(crate) fn start(mux: &Arc<Mux>) {
    if cfg!(test) {
        return;
    }
    let weak = Arc::downgrade(mux);
    if let Err(error) =
        std::thread::Builder::new().name("terminal-ports".into()).spawn(move || run(&weak))
    {
        eprintln!("cmux-tui: terminal ports: not started: {error}");
    }
}

/// Scans until the mux is gone or shuts down. The mux is let go between
/// scans, so dropping it ends the thread.
fn run(weak: &Weak<Mux>) {
    let mut memory = ScanMemory::default();
    loop {
        {
            let Some(mux) = weak.upgrade() else { return };
            if mux.daemon_shutdown_requested() {
                return;
            }
            mux.scan_terminal_ports(&mut memory);
        }
        // A bounded wait between scans, not a synchronization: nothing wakes it.
        std::thread::park_timeout(SCAN_INTERVAL);
    }
}

impl Mux {
    /// One scan: read the terminals' listeners and commit what changed.
    pub(crate) fn scan_terminal_ports(&self, memory: &mut ScanMemory) {
        let (mut terminals, live) = self.with_state(|state| {
            let live: BTreeSet<String> =
                state.workspaces.iter().map(|workspace| workspace.public_id.to_string()).collect();
            let terminals: Vec<TerminalProcess> = state
                .surfaces
                .iter()
                .filter(|(_, surface)| surface.kind() == SurfaceKind::Pty && !surface.is_dead())
                .filter_map(|(id, surface)| {
                    let pid = surface.process_id()?;
                    let workspace = Self::workspace_for_surface_in_state(state, *id)?;
                    let workspace = state.workspace_by_id(workspace)?.public_id.to_string();
                    Some(TerminalProcess { workspace, pid })
                })
                .collect();
            (terminals, live)
        });
        terminals.sort();
        terminals.dedup();
        let Some(listeners) = Listeners::read() else { return };
        let fingerprint = listeners.fingerprint();
        let unchanged = memory.wanted.is_some()
            && fingerprint.is_some()
            && fingerprint == memory.listeners
            && terminals == memory.terminals;
        if unchanged {
            return;
        }
        let sampler = (!terminals.is_empty()).then(Sampler::new);
        let tree = |pid: u32| -> Vec<u32> {
            let Some(sampler) = sampler.as_ref() else { return Vec::new() };
            sampler.tree(pid).nodes.iter().map(|node| node.pid).collect()
        };
        let ports = workspace_ports(&terminals, tree, |pid| listeners.ports_of(pid));
        let wanted: BTreeMap<String, String> =
            ports.iter().map(|(workspace, ports)| (workspace.clone(), ports_text(ports))).collect();
        memory.terminals = terminals;
        memory.listeners = fingerprint;
        if memory.wanted.as_ref() == Some(&wanted) {
            return;
        }
        let stored = match self.read_registry_state(stored_ports) {
            Ok(stored) => stored,
            Err(error) => {
                eprintln!("cmux-tui: terminal ports: reading entries failed: {error}");
                return;
            }
        };
        let mut all_committed = true;
        for change in plan(&live, &stored, &wanted) {
            all_committed &= self.commit_terminal_ports(change);
        }
        // A failed write is tried again by the next scan.
        memory.wanted = all_committed.then_some(wanted);
    }

    fn commit_terminal_ports(&self, change: PortsChange) -> bool {
        let mutation = WorkspaceMutation::daemon_local("terminal.ports");
        let (workspace, operation, change) = match change {
            PortsChange::Set { workspace, text } => (
                workspace,
                "workspace_status.set",
                WorkspaceStatusChange::Set {
                    key: PORTS_KEY.into(),
                    text,
                    icon: Some(PORTS_ICON.into()),
                    color: None,
                    meta: Box::new(StatusMeta::default()),
                },
            ),
            PortsChange::Clear { workspace } => (
                workspace,
                "workspace_status.clear",
                WorkspaceStatusChange::Clear { key: Some(PORTS_KEY.into()) },
            ),
        };
        let selectors = self.local_workspace_selectors(&workspace);
        match self.state_workspace_status(&mutation, operation, None, &selectors, change) {
            Ok(_) => true,
            Err(error) => {
                eprintln!("cmux-tui: terminal ports: {operation} failed: {error}");
                false
            }
        }
    }
}

/// Every stored `ports` entry, by workspace public id.
fn stored_ports(
    connection: &rusqlite::Connection,
) -> anyhow::Result<BTreeMap<String, StoredPorts>> {
    let mut statement = connection.prepare(
        "SELECT workspace_id, text, icon FROM workspace_status_entries WHERE status_key = ?1",
    )?;
    let rows = statement.query_map([PORTS_KEY], |row| {
        Ok((row.get::<_, String>(0)?, StoredPorts { text: row.get(1)?, icon: row.get(2)? }))
    })?;
    Ok(rows.collect::<Result<BTreeMap<_, _>, _>>()?)
}

#[cfg(test)]
#[path = "terminal_ports_tests.rs"]
mod tests;
