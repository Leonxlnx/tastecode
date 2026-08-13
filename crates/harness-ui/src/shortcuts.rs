use gpui::KeyDownEvent;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Shortcut {
    pub(crate) key: &'static str,
    pub(crate) shift: bool,
}

pub(crate) const COMMAND_PALETTE: Shortcut = Shortcut {
    key: "k",
    shift: false,
};
pub(crate) const NEW_CHAT: Shortcut = Shortcut {
    key: "n",
    shift: false,
};
pub(crate) const SWITCH_PROJECT: Shortcut = Shortcut {
    key: "p",
    shift: false,
};
pub(crate) const NEW_PROJECT: Shortcut = Shortcut {
    key: "o",
    shift: true,
};
pub(crate) const SETTINGS: Shortcut = Shortcut {
    key: ",",
    shift: false,
};
pub(crate) const FOCUS_COMPOSER: Shortcut = Shortcut {
    key: "l",
    shift: false,
};
pub(crate) const TOGGLE_SIDEBAR: Shortcut = Shortcut {
    key: "b",
    shift: false,
};
pub(crate) const SEARCH_SESSIONS: Shortcut = Shortcut {
    key: "f",
    shift: true,
};

pub(crate) fn matches(event: &KeyDownEvent, shortcut: Shortcut) -> bool {
    let modifiers = event.keystroke.modifiers;
    (modifiers.platform || modifiers.control)
        && !modifiers.alt
        && modifiers.shift == shortcut.shift
        && event.keystroke.key.eq_ignore_ascii_case(shortcut.key)
}

pub(crate) fn is_button_activation(event: &KeyDownEvent) -> bool {
    !event.is_held
        && matches!(
            event.keystroke.key.to_ascii_lowercase().as_str(),
            "enter" | "space" | " "
        )
}

pub(crate) fn label(shortcut: Shortcut) -> String {
    let key = shortcut.key.to_uppercase();
    if cfg!(target_os = "macos") {
        format!("⌘{}{key}", if shortcut.shift { "⇧" } else { "" })
    } else {
        format!("Ctrl{} {key}", if shortcut.shift { " Shift" } else { "" })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui::{Keystroke, Modifiers};

    fn key_event(key: &str, platform: bool, control: bool, shift: bool) -> KeyDownEvent {
        KeyDownEvent {
            keystroke: Keystroke {
                modifiers: Modifiers {
                    platform,
                    control,
                    shift,
                    ..Default::default()
                },
                key: key.into(),
                key_char: None,
            },
            is_held: false,
        }
    }

    #[test]
    fn shortcuts_accept_command_or_control_and_require_exact_shift() {
        assert!(matches(
            &key_event("K", true, false, false),
            COMMAND_PALETTE
        ));
        assert!(matches(
            &key_event("k", false, true, false),
            COMMAND_PALETTE
        ));
        assert!(!matches(
            &key_event("k", true, false, true),
            COMMAND_PALETTE
        ));
        assert!(matches(&key_event("f", true, false, true), SEARCH_SESSIONS));
    }

    #[test]
    fn labels_match_the_legacy_platform_contract() {
        let expected = if cfg!(target_os = "macos") {
            "⌘⇧O"
        } else {
            "Ctrl Shift O"
        };
        assert_eq!(label(NEW_PROJECT), expected);
    }

    #[test]
    fn button_activation_accepts_enter_and_space_without_key_repeat() {
        assert!(is_button_activation(&key_event(
            "Enter", false, false, false
        )));
        assert!(is_button_activation(&key_event(
            "space", false, false, false
        )));
        let mut repeated = key_event("space", false, false, false);
        repeated.is_held = true;
        assert!(!is_button_activation(&repeated));
        assert!(!is_button_activation(&key_event(
            "escape", false, false, false
        )));
    }
}
