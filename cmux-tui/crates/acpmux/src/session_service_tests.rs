use super::*;

fn status(signed_in: &str, answered: bool) -> Value {
    let mut consent =
        json!({"screen": "none", "control": "granted", "signedInMachines": signed_in});
    if answered {
        consent["signedInMachinesAnsweredAt"] = json!("1");
    }
    json!({"consentRequired": true, "consent": consent, "lastRefusal": null})
}

#[test]
fn off_by_default_and_the_first_refusal_is_the_one_ask() {
    // A machine signing in made: nothing granted, nothing answered.
    match decide(&status("none", false)) {
        Decision::Refuse { refusal, ask } => {
            assert_eq!(refusal.reason, CONSENT_REQUIRED);
            assert!(ask, "the first refusal asks the person on that machine");
        }
        Decision::Admit => panic!("signing in alone admitted a workspace"),
    }
    // Control from elsewhere is another grant: it does not open workspaces for the account.
    assert_ne!(decide(&status("none", false)), Decision::Admit);
}

#[test]
fn after_not_now_no_new_ask_and_after_allow_admitted() {
    match decide(&status("none", true)) {
        Decision::Refuse { refusal, ask } => {
            assert_eq!(refusal.reason, CONSENT_DECLINED);
            assert!(!ask, "asked once");
        }
        Decision::Admit => panic!("Not now admitted"),
    }
    assert_eq!(decide(&status("granted", true)), Decision::Admit);
}

#[test]
fn an_unreadable_or_odd_status_refuses() {
    for odd in [json!({}), json!({"consent": {"signedInMachines": true}}), json!(null)] {
        assert_ne!(decide(&odd), Decision::Admit, "{odd}");
    }
    // consentRequired false (a machine never joined) still needs the grant itself.
    let unjoined = json!({"consentRequired": false, "consent": {"signedInMachines": "none"}});
    assert_ne!(decide(&unjoined), Decision::Admit);
}

#[cfg(unix)]
#[test]
fn only_an_own_socket_is_reached() {
    let dir = tempfile::tempdir().unwrap();
    assert_eq!(session_socket(None).unwrap_err().reason, "service.off");
    assert_eq!(session_socket(Some(Path::new("relative.sock"))).unwrap_err().reason, "service.off");
    let missing = dir.path().join("missing.sock");
    assert_eq!(session_socket(Some(&missing)).unwrap_err().reason, "service.unreachable");
    let file = dir.path().join("file.sock");
    std::fs::write(&file, b"").unwrap();
    assert_eq!(session_socket(Some(&file)).unwrap_err().reason, "service.unreachable");
    let socket = dir.path().join("tui.sock");
    let _listener = std::os::unix::net::UnixListener::bind(&socket).unwrap();
    assert_eq!(session_socket(Some(&socket)).unwrap(), socket);
    let link = dir.path().join("link.sock");
    std::os::unix::fs::symlink(&socket, &link).unwrap();
    assert_eq!(
        session_socket(Some(&link)).unwrap_err().reason,
        "service.unreachable",
        "a symlink is never followed to a socket"
    );
}
