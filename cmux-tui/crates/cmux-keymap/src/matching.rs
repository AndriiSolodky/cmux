//! Whether a stroke matches a key event, per `app.shortcutLayout`
//! (key-vectors.json's `$shortcutComment`).

use crate::stroke::named_key;
use crate::table::table;
use crate::{KeyEvent, ShortcutLayout, Stroke};

/// The named keys' physical keys: W3C code, stroke name, macOS kVK code. key-styles.json's
/// `keys` table holds the character keys; these are the non-character keys a stroke can name.
const NAMED_PHYSICAL: [(&str, &str, u16); 9] = [
    ("Enter", "enter", 36),
    ("NumpadEnter", "enter", 76),
    ("Escape", "escape", 53),
    ("PageUp", "pageup", 116),
    ("PageDown", "pagedown", 121),
    ("ArrowLeft", "left", 123),
    ("ArrowRight", "right", 124),
    ("ArrowDown", "down", 125),
    ("ArrowUp", "up", 126),
];

/// The W3C code of a macOS virtual key code (kVK_*), from key-styles.json's `keys` and the
/// named keys (Escape, Enter, the arrows, PageUp, PageDown).
pub fn code_for_mac_key_code(mac: u16) -> Option<&'static str> {
    if let Some(key) = table().keys.iter().find(|k| k.mac == mac) {
        return Some(key.code.as_str());
    }
    NAMED_PHYSICAL.iter().find(|(_, _, m)| *m == mac).map(|(code, _, _)| *code)
}

/// The macOS virtual key code of a W3C code, the inverse of [`code_for_mac_key_code`].
pub fn mac_key_code_for_code(code: &str) -> Option<u16> {
    if let Some(key) = table().keys.iter().find(|k| k.code == code) {
        return Some(key.mac);
    }
    NAMED_PHYSICAL.iter().find(|(c, _, _)| *c == code).map(|(_, _, mac)| *mac)
}

/// What the key at W3C `code` types on the US layout (`KeyZ` is `z`, `BracketLeft` is `[`).
pub fn qwerty_char(code: &str) -> Option<&'static str> {
    table().keys.iter().find(|k| k.code == code).map(|k| k.qwerty.as_str())
}

/// The named key of an event: by its key name (`escape`), else by its code (`ArrowDown`).
fn event_named(event: &KeyEvent<'_>) -> Option<&'static str> {
    if event.key.chars().nth(1).is_some()
        && let Some(named) = named_key(event.key)
    {
        return Some(named);
    }
    let code = event.code?;
    NAMED_PHYSICAL.iter().find(|(c, _, _)| *c == code).map(|(_, name, _)| *name)
}

fn is_dead_or_non_ascii(key: &str) -> bool {
    key.is_empty() || key == "Dead" || !key.is_ascii()
}

/// Whether `stroke` matches `event` in the `layout` mode. Modifiers always match exactly,
/// Shift included, except for a character the layout types only with Shift (followLayout).
pub fn stroke_matches(layout: ShortcutLayout, stroke: &Stroke, event: &KeyEvent<'_>) -> bool {
    if let Some(named) = event_named(event) {
        return stroke.mods == event.mods && stroke.key == named;
    }
    if stroke.is_named() {
        return false;
    }
    if layout == ShortcutLayout::QwertyPositions
        && let Some(us) = event.code.and_then(qwerty_char)
    {
        return stroke.mods == event.mods && stroke.key == us;
    }
    // followLayout, and qwertyPositions for an event with no known physical key.
    follow_layout(stroke, event)
}

fn follow_layout(stroke: &Stroke, event: &KeyEvent<'_>) -> bool {
    if stroke.mods == event.mods {
        // The character the layout types; a dead key or a non-ASCII character counts as its
        // US position (QWERTZ's ü is `[`).
        let typed = if is_dead_or_non_ascii(event.key) {
            event.code.and_then(qwerty_char).map(str::to_owned)
        } else {
            Some(event.key.to_ascii_lowercase())
        };
        if typed.as_deref() == Some(stroke.key.as_str()) {
            return true;
        }
        // A digit-row key also counts as its digit (AZERTY's & key is 1).
        if let Some(digit) = event.code.and_then(|c| c.strip_prefix("Digit"))
            && digit.len() == 1
            && digit.bytes().all(|b| b.is_ascii_digit())
            && stroke.key == digit
        {
            return true;
        }
    }
    // A character the layout only types with Shift matches a binding without Shift
    // (AZERTY's / is Shift-:), but never a letter's capital (Cmd-Shift-Z stays Cmd-Shift-Z).
    if event.mods.shift
        && let Some(shifted) = event.shifted_key
        && !shifted.is_empty()
        && shifted.is_ascii()
        && !shifted.chars().any(char::is_alphabetic)
        && stroke.mods == event.mods.without_shift()
        && stroke.key == shifted
    {
        return true;
    }
    false
}
