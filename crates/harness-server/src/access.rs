use std::net::IpAddr;
use std::str::FromStr as _;
use subtle::ConstantTimeEq as _;
use url::Url;

pub fn allowed_origin(origin: Option<&str>) -> bool {
    let Some(origin) = origin else {
        return true;
    };
    if origin == "file://" {
        return true;
    }
    let Ok(url) = Url::parse(origin) else {
        return false;
    };
    let Some(host) = url.host_str() else {
        return false;
    };
    if host.eq_ignore_ascii_case("localhost") {
        return true;
    }
    let host = host
        .strip_prefix('[')
        .and_then(|host| host.strip_suffix(']'))
        .unwrap_or(host);
    IpAddr::from_str(host)
        .map(|address| address.is_loopback())
        .unwrap_or(false)
}

pub fn has_access(request_uri: &str, expected: Option<&str>) -> bool {
    let Some(expected) = expected.filter(|token| !token.is_empty()) else {
        return true;
    };
    let Ok(url) = Url::parse(&format!("ws://harness.local{request_uri}")) else {
        return false;
    };
    let Some(supplied) = url
        .query_pairs()
        .find_map(|(key, value)| (key == "token").then(|| value.into_owned()))
    else {
        return false;
    };
    expected.len() == supplied.len() && bool::from(expected.as_bytes().ct_eq(supplied.as_bytes()))
}

pub fn assert_safe_bind(host: IpAddr, access_token: Option<&str>) -> Result<(), &'static str> {
    if !host.is_loopback() && access_token.is_none_or(str::is_empty) {
        return Err("HARNESS_ACCESS_TOKEN is required when HARNESS_HOST is not loopback");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn admits_only_owned_or_loopback_origins() {
        assert!(allowed_origin(None));
        assert!(allowed_origin(Some("file://")));
        assert!(allowed_origin(Some("http://127.0.0.1:5183")));
        assert!(allowed_origin(Some("http://127.99.2.4:5183")));
        assert!(allowed_origin(Some("http://localhost:5173")));
        assert!(allowed_origin(Some("http://[::1]:5173")));
        assert!(!allowed_origin(Some("https://evil.example")));
        assert!(!allowed_origin(Some("null")));
        assert!(!allowed_origin(Some("http://127.0.0.1.evil.example")));
        assert!(!allowed_origin(Some("http://localhost.evil.example")));
        assert!(!allowed_origin(Some("not a url")));
    }

    #[test]
    fn access_tokens_are_exact_and_percent_decoded() {
        assert!(has_access("/", None));
        assert!(has_access("/?token=correct-token", Some("correct-token")));
        assert!(has_access("/?token=space%20token", Some("space token")));
        assert!(!has_access("/?token=wrong-token", Some("correct-token")));
        assert!(!has_access("/", Some("correct-token")));
    }

    #[test]
    fn external_binds_require_a_token() {
        assert!(assert_safe_bind(IpAddr::from([127, 0, 0, 1]), None).is_ok());
        assert!(assert_safe_bind(IpAddr::V6(std::net::Ipv6Addr::LOCALHOST), None).is_ok());
        assert!(assert_safe_bind(IpAddr::from([0, 0, 0, 0]), Some("secret")).is_ok());
        assert!(assert_safe_bind(IpAddr::from([0, 0, 0, 0]), None).is_err());
        assert!(assert_safe_bind(IpAddr::from([192, 168, 1, 4]), Some("")).is_err());
    }
}
