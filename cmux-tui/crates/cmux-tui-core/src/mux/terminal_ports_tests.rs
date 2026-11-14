//! The terminal ports rules without live processes: which workspace a
//! listener counts for, the entry's text, and which entries a scan writes.

use std::collections::{BTreeMap, BTreeSet, HashMap};

use super::*;

fn terminal(workspace: &str, pid: u32) -> TerminalProcess {
    TerminalProcess { workspace: workspace.into(), pid }
}

#[test]
fn a_listener_anywhere_in_a_terminals_tree_counts_for_its_workspace() {
    // ws_a: shell 10 -> npm 11 -> node 12 (listens on 5173); shell 20 listens on 3000.
    // ws_b: shell 30, nothing listening. Process 99 is outside every terminal.
    let trees: HashMap<u32, Vec<u32>> =
        HashMap::from([(10, vec![10, 11, 12]), (20, vec![20]), (30, vec![30])]);
    let listening: HashMap<u32, Vec<u16>> =
        HashMap::from([(12, vec![5173]), (20, vec![3000]), (99, vec![8080])]);
    let ports = workspace_ports(
        &[terminal("ws_a", 10), terminal("ws_a", 20), terminal("ws_b", 30)],
        |pid| trees.get(&pid).cloned().unwrap_or_default(),
        |pid| listening.get(&pid).into_iter().flatten().copied().collect(),
    );
    assert_eq!(ports, BTreeMap::from([("ws_a".to_owned(), BTreeSet::from([3000, 5173]))]));
    assert_eq!(ports_text(&ports["ws_a"]), ":3000, :5173");
}

fn stored(text: &str, icon: Option<&str>) -> StoredPorts {
    StoredPorts { text: text.into(), icon: icon.map(str::to_owned) }
}

#[test]
fn a_scan_writes_only_the_daemons_own_entries_of_live_workspaces() {
    let live: BTreeSet<String> = ["new", "changed", "same", "closed", "person", "gone_ws_kept"]
        .into_iter()
        .map(str::to_owned)
        .collect();
    let stored = BTreeMap::from([
        ("changed".to_owned(), stored(":3000", Some(PORTS_ICON))),
        ("same".to_owned(), stored(":4000", Some(PORTS_ICON))),
        ("closed".to_owned(), stored(":5000", Some(PORTS_ICON))),
        ("person".to_owned(), stored("api :8080", None)),
        // Another session's workspace: not live here, never touched.
        ("elsewhere".to_owned(), stored(":6000", Some(PORTS_ICON))),
    ]);
    let wanted = BTreeMap::from([
        ("new".to_owned(), ":1234".to_owned()),
        ("changed".to_owned(), ":3000, :3001".to_owned()),
        ("same".to_owned(), ":4000".to_owned()),
        ("person".to_owned(), ":9000".to_owned()),
    ]);
    assert_eq!(
        plan(&live, &stored, &wanted),
        [
            PortsChange::Set { workspace: "changed".into(), text: ":3000, :3001".into() },
            PortsChange::Clear { workspace: "closed".into() },
            PortsChange::Set { workspace: "new".into(), text: ":1234".into() },
        ]
    );
}
