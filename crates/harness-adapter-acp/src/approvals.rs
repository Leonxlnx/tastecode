use harness_protocol::ApprovalDecision;

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct PermissionOption {
    pub option_id: Option<String>,
    pub kind: Option<String>,
}

pub fn option_for(options: &[PermissionOption], decision: ApprovalDecision) -> Option<&str> {
    let wanted = match decision {
        ApprovalDecision::Approve => "allow_once",
        ApprovalDecision::ApproveSession => "allow_always",
        ApprovalDecision::Deny | ApprovalDecision::Abort => "reject_once",
    };
    if let Some(exact) = options
        .iter()
        .find(|option| option.kind.as_deref() == Some(wanted))
        && let Some(option_id) = exact.option_id.as_deref()
    {
        return Some(option_id);
    }
    let direction = if wanted.starts_with("allow") {
        "allow"
    } else {
        "reject"
    };
    options
        .iter()
        .find(|option| {
            option
                .kind
                .as_deref()
                .is_some_and(|kind| kind.starts_with(direction))
                && option.option_id.is_some()
        })
        .and_then(|option| option.option_id.as_deref())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn option(id: &str, kind: &str) -> PermissionOption {
        PermissionOption {
            option_id: Some(id.into()),
            kind: Some(kind.into()),
        }
    }

    #[test]
    fn maps_every_decision_to_the_matching_wire_direction() {
        let options = [
            option("always", "allow_always"),
            option("once", "allow_once"),
            option("cancel", "reject_once"),
        ];
        assert_eq!(
            option_for(&options, ApprovalDecision::Approve),
            Some("once")
        );
        assert_eq!(
            option_for(&options, ApprovalDecision::ApproveSession),
            Some("always")
        );
        assert_eq!(option_for(&options, ApprovalDecision::Deny), Some("cancel"));
        assert_eq!(
            option_for(&options, ApprovalDecision::Abort),
            Some("cancel")
        );
    }

    #[test]
    fn falls_back_only_within_the_same_permission_direction() {
        let no_reject_once = [
            option("yes", "allow_once"),
            option("never", "reject_always"),
        ];
        assert_eq!(
            option_for(&no_reject_once, ApprovalDecision::Deny),
            Some("never")
        );
        let no_allow_always = [option("yes", "allow_once"), option("no", "reject_once")];
        assert_eq!(
            option_for(&no_allow_always, ApprovalDecision::ApproveSession),
            Some("yes")
        );
        assert_eq!(
            option_for(&[option("yes", "allow_once")], ApprovalDecision::Deny),
            None
        );
    }

    #[test]
    fn ignores_options_without_an_identifier() {
        let broken = PermissionOption {
            option_id: None,
            kind: Some("allow_once".into()),
        };
        assert_eq!(option_for(&[broken], ApprovalDecision::Approve), None);
        assert_eq!(option_for(&[], ApprovalDecision::Approve), None);
    }
}
