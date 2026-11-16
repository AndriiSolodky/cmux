//! The screen share helper's own grants (screen-share design D9): `cmux-rd status --json` and
//! `cmux-rd request-permissions`.
//!
//! On macOS the app starts this binary as `cmux Screen Share.app` with responsibility
//! disclaimed, so these answers are the helper's grants, never the app's: a grant the person
//! gives the helper takes effect at the helper's next start, with the app left running. Each
//! answer is read fresh by a new process (a long-running process can keep an old Screen
//! Recording answer), so the app starts one per check.
//!
//! The JSON shape is shared with the Linux unit (`cmux-rd linux-host status --json`) and is
//! what the machine capability record advertises as `screenShare`:
//! `{"schema","platform","state","control","display","helperVersion","missing"}`, where `state`
//! is `granted`, `needs_grant`, `not_installed` or `unsupported`. `not_installed` is only ever
//! said by a caller that could not find the helper; a running helper is installed.
// Only macOS builds the reader; elsewhere the shape stays for its tests.
#![cfg_attr(not(target_os = "macos"), allow(dead_code))]

use crate::Res;
use serde::Serialize;
use std::io::Write;

pub(crate) const SCHEMA: &str = "cmux.screen-share.status/1";

#[derive(Serialize, Debug, PartialEq)]
pub(crate) struct Display {
    pub capture: &'static str,
    pub width: u32,
    pub height: u32,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Status {
    pub schema: &'static str,
    pub platform: &'static str,
    pub state: &'static str,
    /// A viewer's clicks and keys can be applied now.
    pub control: bool,
    pub display: Option<Display>,
    pub helper_version: &'static str,
    /// What a person must allow for `state` to be `granted` and `control` true.
    pub missing: Vec<&'static str>,
}

/// The status from the two grants: Screen Recording decides whether this Mac can be seen at all,
/// Accessibility only whether it can be controlled.
pub(crate) fn status(screen_recording: bool, accessibility: bool, display: Option<Display>) -> Status {
    let mut missing = Vec::new();
    if !screen_recording {
        missing.push("screen_recording");
    }
    if !accessibility {
        missing.push("accessibility");
    }
    Status {
        schema: SCHEMA,
        platform: "macos",
        state: if screen_recording { "granted" } else { "needs_grant" },
        control: screen_recording && accessibility,
        display,
        helper_version: env!("CARGO_PKG_VERSION"),
        missing,
    }
}

fn write_status(output: &mut impl Write, status: &Status) -> Res<()> {
    serde_json::to_writer(&mut *output, status)?;
    output.write_all(b"\n")?;
    Ok(())
}

/// `cmux-rd status [--json]`: one JSON line. Asks for nothing.
pub(crate) fn run_status() -> Res<()> {
    let status = platform::read()?;
    write_status(&mut std::io::stdout().lock(), &status)
}

/// `cmux-rd request-permissions`: this process asks macOS for Screen Recording and
/// Accessibility (the system prompts name the helper), then prints the status. A grant given in
/// System Settings after the prompt applies to the next helper process, never to this one.
pub(crate) fn run_request() -> Res<()> {
    platform::request()?;
    run_status()
}

#[cfg(target_os = "macos")]
mod platform {
    use super::{status, Display, Status};
    use crate::Res;
    use cmux_encode::framework;
    use std::ffi::{c_long, c_void};

    type CFTypeRef = *const c_void;
    type CFStringRef = *const c_void;
    type CFDictionaryRef = *const c_void;
    type CGDisplayModeRef = *mut c_void;

    #[repr(C)]
    pub struct DictCallbacks {
        _private: [u8; 0],
    }

    framework! {
        pub mod cf = "/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation" {
            static kCFBooleanTrue: CFTypeRef;
            ref kCFTypeDictionaryKeyCallBacks: DictCallbacks;
            ref kCFTypeDictionaryValueCallBacks: DictCallbacks;
            fn CFDictionaryCreate(allocator: *const c_void, keys: *const CFTypeRef, values: *const CFTypeRef, count: c_long,
                                  key_callbacks: *const DictCallbacks, value_callbacks: *const DictCallbacks) -> CFDictionaryRef;
            fn CFRelease(value: CFTypeRef);
        }
    }

    framework! {
        pub mod cg = "/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics" {
            fn CGPreflightScreenCaptureAccess() -> bool;
            fn CGRequestScreenCaptureAccess() -> bool;
            fn CGMainDisplayID() -> u32;
            fn CGDisplayCopyDisplayMode(display: u32) -> CGDisplayModeRef;
            fn CGDisplayModeGetPixelWidth(mode: CGDisplayModeRef) -> usize;
            fn CGDisplayModeGetPixelHeight(mode: CGDisplayModeRef) -> usize;
            fn CGDisplayModeRelease(mode: CGDisplayModeRef);
        }
    }

    framework! {
        pub mod ax = "/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices" {
            static kAXTrustedCheckOptionPrompt: CFStringRef;
            fn AXIsProcessTrusted() -> u8;
            fn AXIsProcessTrustedWithOptions(options: CFDictionaryRef) -> u8;
        }
    }

    fn loaded() -> Res<()> {
        cf::available()?;
        cg::available()?;
        ax::available()?;
        Ok(())
    }

    /// The main display's native pixel size; reading a display mode needs no grant.
    fn main_display() -> Option<Display> {
        // SAFETY: resolved in `loaded`; CGMainDisplayID has no preconditions, and the mode is
        // released after its two reads.
        unsafe {
            let mode = cg::CGDisplayCopyDisplayMode(cg::CGMainDisplayID());
            if mode.is_null() {
                return None;
            }
            let (width, height) = (cg::CGDisplayModeGetPixelWidth(mode), cg::CGDisplayModeGetPixelHeight(mode));
            cg::CGDisplayModeRelease(mode);
            Some(Display { capture: "screencapturekit", width: u32::try_from(width).ok()?, height: u32::try_from(height).ok()? })
        }
    }

    pub(super) fn read() -> Res<Status> {
        loaded()?;
        // SAFETY: both no-argument queries are resolved above and return plain C values.
        let (screen_recording, accessibility) =
            unsafe { (cg::CGPreflightScreenCaptureAccess(), ax::AXIsProcessTrusted() != 0) };
        Ok(status(screen_recording, accessibility, main_display()))
    }

    pub(super) fn request() -> Res<()> {
        loaded()?;
        // SAFETY: resolved above. The options dictionary holds two framework constants, is
        // created with the CF type callbacks and released after the call.
        unsafe {
            if !cg::CGPreflightScreenCaptureAccess() {
                cg::CGRequestScreenCaptureAccess();
            }
            if ax::AXIsProcessTrusted() == 0 {
                let keys = [ax::kAXTrustedCheckOptionPrompt()];
                let values = [cf::kCFBooleanTrue()];
                let options = cf::CFDictionaryCreate(
                    std::ptr::null(),
                    keys.as_ptr(),
                    values.as_ptr(),
                    1,
                    cf::kCFTypeDictionaryKeyCallBacks(),
                    cf::kCFTypeDictionaryValueCallBacks(),
                );
                if options.is_null() {
                    return Err("could not build the Accessibility prompt options".into());
                }
                ax::AXIsProcessTrustedWithOptions(options);
                cf::CFRelease(options);
            }
        }
        Ok(())
    }
}

#[cfg(not(target_os = "macos"))]
mod platform {
    use super::Status;
    use crate::Res;

    pub(super) fn read() -> Res<Status> {
        Err("cmux-rd status is the macOS helper's; on Linux use cmux-rd linux-host status --json".into())
    }

    pub(super) fn request() -> Res<()> {
        Err("cmux-rd request-permissions is the macOS helper's".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn json(status: &Status) -> serde_json::Value {
        let mut output = Vec::new();
        write_status(&mut output, status).expect("status");
        assert_eq!(output.last(), Some(&b'\n'));
        serde_json::from_slice(&output).expect("JSON")
    }

    #[test]
    fn status_without_screen_recording_needs_a_grant_and_has_no_control() {
        let value = json(&status(false, true, None));
        assert_eq!(value["schema"], SCHEMA);
        assert_eq!(value["state"], "needs_grant");
        assert_eq!(value["control"], false);
        assert_eq!(value["missing"], serde_json::json!(["screen_recording"]));
        assert!(value["display"].is_null());
    }

    #[test]
    fn status_with_screen_recording_only_is_view_only() {
        let value = json(&status(true, false, Some(Display { capture: "screencapturekit", width: 3024, height: 1964 })));
        assert_eq!(value["state"], "granted");
        assert_eq!(value["control"], false);
        assert_eq!(value["missing"], serde_json::json!(["accessibility"]));
        assert_eq!(value["display"], serde_json::json!({"capture": "screencapturekit", "width": 3024, "height": 1964}));
    }

    #[test]
    fn status_with_both_grants_controls_and_misses_nothing() {
        let value = json(&status(true, true, None));
        assert_eq!(value["state"], "granted");
        assert_eq!(value["control"], true);
        assert_eq!(value["missing"], serde_json::json!([]));
        assert_eq!(value["helperVersion"], env!("CARGO_PKG_VERSION"));
        assert_eq!(value["platform"], "macos");
    }

    #[test]
    fn status_and_request_take_no_options_but_json() {
        assert_eq!(crate::run_cli(&["status".into(), "--request".into()]), 2);
        assert_eq!(crate::run_cli(&["request-permissions".into(), "--json".into()]), 2);
    }
}
