use std::collections::{BTreeMap, BTreeSet};
use std::io::Read;
use std::net::{IpAddr, SocketAddr, ToSocketAddrs};
use std::time::Duration;

use regex::Regex;
use reqwest::blocking::Client;
use reqwest::redirect::Policy;
use reqwest::Url;
use serde_json::{json, Value};

use super::external_evidence::{
    ExternalSearchEntry, ExternalSearchOutcome, GuardedExternalEvidence,
};
use super::helpers::truncate;
use super::types::{NegativeCoveringExecution, EXTERNAL_FETCH_BYTE_LIMIT};

pub(super) fn search_external(
    query: &str,
    execution: &NegativeCoveringExecution,
    timeout_seconds: u64,
) -> Result<ExternalSearchOutcome, String> {
    let providers = execution
        .external_search
        .provider_order
        .iter()
        .take(execution.external_search.max_provider_attempts.max(1));
    let mut attempted_providers = Vec::new();
    let mut provider_errors = BTreeMap::new();
    let mut last_empty = None;
    for provider in providers {
        attempted_providers.push(provider.clone());
        let result = match provider.as_str() {
            "duckduckgo" => search_duckduckgo(query, timeout_seconds),
            "brave" => search_brave(
                query,
                execution.external_search.brave_api_key.as_deref(),
                execution.external_search.result_count,
                timeout_seconds,
            ),
            "exa" => search_exa(
                query,
                execution.external_search.exa_api_key.as_deref(),
                execution.external_search.result_count,
                timeout_seconds,
            ),
            _ => Err(format!("unsupported search provider: {provider}")),
        };
        match result {
            Ok(mut results) => {
                results.truncate(execution.external_search.result_count);
                let outcome = ExternalSearchOutcome {
                    provider: provider.clone(),
                    results,
                    attempted_providers: attempted_providers.clone(),
                    provider_errors: provider_errors.clone(),
                };
                if !outcome.results.is_empty() {
                    return Ok(outcome);
                }
                last_empty = Some(outcome);
            }
            Err(error) => {
                provider_errors.insert(provider.clone(), truncate(&error, 500));
            }
        }
    }
    if let Some(mut outcome) = last_empty {
        outcome.provider_errors = provider_errors;
        return Ok(outcome);
    }
    let details = provider_errors
        .iter()
        .map(|(provider, error)| format!("{provider}: {error}"))
        .collect::<Vec<_>>()
        .join("; ");
    Err(if details.is_empty() {
        "no search providers configured".to_string()
    } else {
        format!("search providers failed: {details}")
    })
}

pub(super) fn search_duckduckgo(
    query: &str,
    timeout_seconds: u64,
) -> Result<Vec<ExternalSearchEntry>, String> {
    let mut url = Url::parse("https://duckduckgo.com/html/")
        .map_err(|error| format!("invalid DuckDuckGo URL: {error}"))?;
    url.query_pairs_mut().append_pair("q", query);
    let client = Client::builder()
        .timeout(Duration::from_secs(timeout_seconds.clamp(10, 60)))
        .redirect(Policy::none())
        .build()
        .map_err(|error| format!("failed to build search client: {error}"))?;
    let response = client
        .get(url)
        .header(
            "user-agent",
            "context-still-distillation/0.1 (+https://localhost; compile-ready knowledge verifier)",
        )
        .send()
        .map_err(|error| format!("DuckDuckGo request failed: {error}"))?;
    if !response.status().is_success() {
        return Err(format!("DuckDuckGo HTTP {}", response.status().as_u16()));
    }
    let bytes = read_bounded_body(response, EXTERNAL_FETCH_BYTE_LIMIT, "search_web")
        .map_err(|error| format!("failed to read DuckDuckGo response: {error}"))?;
    let html = String::from_utf8_lossy(&bytes);
    let pattern = Regex::new(
        r#"(?is)<a[^>]*class=["'][^"']*\bresult__a\b[^"']*["'][^>]*href=["']([^"']+)["'][^>]*>(.*?)</a>"#,
    )
    .expect("DuckDuckGo result regex");
    let mut seen = BTreeSet::new();
    let mut results = Vec::new();
    for capture in pattern.captures_iter(&html) {
        let raw_url = capture
            .get(1)
            .map(|value| value.as_str())
            .unwrap_or_default();
        let cleaned_url = clean_duckduckgo_result_url(raw_url);
        if cleaned_url.is_empty() || !seen.insert(cleaned_url.clone()) {
            continue;
        }
        let title = strip_html(
            capture
                .get(2)
                .map(|value| value.as_str())
                .unwrap_or_default(),
        );
        if title.is_empty() {
            continue;
        }
        results.push(ExternalSearchEntry {
            title,
            url: cleaned_url,
        });
        if results.len() >= 8 {
            break;
        }
    }
    Ok(results)
}

pub(super) fn search_brave(
    query: &str,
    api_key: Option<&str>,
    result_count: usize,
    timeout_seconds: u64,
) -> Result<Vec<ExternalSearchEntry>, String> {
    let api_key = api_key.ok_or_else(|| "Brave API key is not configured".to_string())?;
    let client = Client::builder()
        .timeout(Duration::from_secs(timeout_seconds.clamp(10, 60)))
        .redirect(Policy::none())
        .build()
        .map_err(|error| format!("failed to build Brave search client: {error}"))?;
    let count = result_count.to_string();
    let response = client
        .get("https://api.search.brave.com/res/v1/web/search")
        .query(&[("q", query), ("count", count.as_str())])
        .header("accept", "application/json")
        .header("x-subscription-token", api_key)
        .send()
        .map_err(|error| format!("Brave request failed: {error}"))?;
    if !response.status().is_success() {
        return Err(format!("Brave HTTP {}", response.status().as_u16()));
    }
    let payload: Value = serde_json::from_slice(&read_bounded_body(
        response,
        EXTERNAL_FETCH_BYTE_LIMIT,
        "search_web",
    )?)
    .map_err(|error| format!("failed to parse Brave response: {error}"))?;
    Ok(payload
        .pointer("/web/results")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|entry| {
            let title = strip_html(entry.get("title")?.as_str()?);
            let url = entry.get("url")?.as_str()?.trim().to_string();
            (!title.is_empty() && !url.is_empty()).then_some(ExternalSearchEntry { title, url })
        })
        .take(result_count)
        .collect())
}

pub(super) fn search_exa(
    query: &str,
    api_key: Option<&str>,
    result_count: usize,
    timeout_seconds: u64,
) -> Result<Vec<ExternalSearchEntry>, String> {
    let api_key = api_key.ok_or_else(|| "Exa API key is not configured".to_string())?;
    let client = Client::builder()
        .timeout(Duration::from_secs(timeout_seconds.clamp(10, 60)))
        .redirect(Policy::none())
        .build()
        .map_err(|error| format!("failed to build Exa search client: {error}"))?;
    let response = client
        .post("https://api.exa.ai/search")
        .header("accept", "application/json")
        .header("x-api-key", api_key)
        .json(&json!({"query": query, "numResults": result_count}))
        .send()
        .map_err(|error| format!("Exa request failed: {error}"))?;
    if !response.status().is_success() {
        return Err(format!("Exa HTTP {}", response.status().as_u16()));
    }
    let payload: Value = serde_json::from_slice(&read_bounded_body(
        response,
        EXTERNAL_FETCH_BYTE_LIMIT,
        "search_web",
    )?)
    .map_err(|error| format!("failed to parse Exa response: {error}"))?;
    Ok(payload
        .get("results")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|entry| {
            let title = strip_html(entry.get("title")?.as_str()?);
            let url = entry.get("url")?.as_str()?.trim().to_string();
            (!title.is_empty() && !url.is_empty()).then_some(ExternalSearchEntry { title, url })
        })
        .take(result_count)
        .collect())
}

pub(super) fn clean_duckduckgo_result_url(raw: &str) -> String {
    let decoded = raw.replace("&amp;", "&");
    let absolute = if decoded.starts_with("//") {
        format!("https:{decoded}")
    } else {
        decoded
    };
    let Ok(url) = Url::parse(&absolute) else {
        return absolute;
    };
    if url.host_str().is_some_and(|host| {
        host.eq_ignore_ascii_case("duckduckgo.com")
            || host.to_ascii_lowercase().ends_with(".duckduckgo.com")
    }) {
        if let Some(target) = url
            .query_pairs()
            .find(|(key, _)| key == "uddg")
            .map(|(_, value)| value.into_owned())
        {
            return target;
        }
    }
    url.to_string()
}

pub(super) fn fetch_guarded_external_url(
    raw_url: &str,
    timeout_seconds: u64,
) -> Result<GuardedExternalEvidence, String> {
    fetch_guarded_external_url_with_text_limit(raw_url, timeout_seconds, 12_000)
}

pub(super) fn fetch_guarded_external_url_with_text_limit(
    raw_url: &str,
    timeout_seconds: u64,
    text_limit: usize,
) -> Result<GuardedExternalEvidence, String> {
    let mut current = Url::parse(raw_url).map_err(|error| format!("invalid URL: {error}"))?;
    for _ in 0..=5 {
        let (host, address) = validate_external_url(&current)?;
        let client = Client::builder()
            .timeout(Duration::from_secs(timeout_seconds.clamp(10, 60)))
            .redirect(Policy::none())
            .resolve(&host, address)
            .build()
            .map_err(|error| format!("failed to build pinned fetch client: {error}"))?;
        let response = client
            .get(current.clone())
            .header(
                "user-agent",
                "context-still-distillation/0.1 (+https://localhost; compile-ready knowledge verifier)",
            )
            .send()
            .map_err(|error| format!("fetch_content request failed: {error}"))?;
        if response.status().is_redirection() {
            let location = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|value| value.to_str().ok())
                .ok_or_else(|| "fetch_content redirect omitted Location".to_string())?;
            current = current
                .join(location)
                .map_err(|error| format!("invalid fetch_content redirect: {error}"))?;
            continue;
        }
        if !response.status().is_success() {
            return Err(format!("fetch_content HTTP {}", response.status().as_u16()));
        }
        let content_type = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or("application/octet-stream")
            .to_string();
        if !is_supported_external_content_type(&content_type) {
            return Err(format!(
                "fetch_content blocked: unsupported content type {}",
                truncate(&content_type, 120)
            ));
        }
        let bytes = read_bounded_external_body(response)?;
        let body = String::from_utf8_lossy(&bytes);
        let extracted = if content_type.to_ascii_lowercase().contains("html")
            || body.to_ascii_lowercase().contains("<html")
        {
            strip_html(&body)
        } else {
            body.to_string()
        };
        let text = truncate(&extracted, text_limit);
        inspect_external_evidence_guard(&text)?;
        return Ok(GuardedExternalEvidence {
            url: current.to_string(),
            text,
            content_type,
        });
    }
    Err("fetch_content redirect limit exceeded".to_string())
}

pub(super) fn classify_external_fetch_error(error: &str) -> (&'static str, &'static str) {
    if error.contains("prompt_injection_blocked") {
        ("prompt_injection_blocked", "deny")
    } else if error.contains("fetch_content blocked") {
        ("external_fetch_blocked", "deny")
    } else {
        ("external_fetch_failed", "unavailable")
    }
}

pub(super) fn is_supported_external_content_type(content_type: &str) -> bool {
    let mime = content_type
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    mime.starts_with("text/")
        || matches!(
            mime.as_str(),
            "application/json"
                | "application/ld+json"
                | "application/xml"
                | "application/xhtml+xml"
                | "application/rss+xml"
                | "application/atom+xml"
        )
        || mime.ends_with("+json")
        || mime.ends_with("+xml")
}

pub(super) fn read_bounded_external_body(reader: impl Read) -> Result<Vec<u8>, String> {
    read_bounded_body(reader, EXTERNAL_FETCH_BYTE_LIMIT, "fetch_content")
}

pub(super) fn read_bounded_body(
    reader: impl Read,
    byte_limit: usize,
    label: &str,
) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    reader
        .take((byte_limit + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("failed to read {label} response: {error}"))?;
    if bytes.len() > byte_limit {
        return Err(format!("{label} response exceeded byte limit"));
    }
    Ok(bytes)
}

pub(super) fn validate_external_url(url: &Url) -> Result<(String, SocketAddr), String> {
    if !matches!(url.scheme(), "http" | "https") {
        return Err("fetch_content blocked: only http/https are allowed".to_string());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("fetch_content blocked: URL credentials are not allowed".to_string());
    }
    if url.port().is_some() {
        return Err("fetch_content blocked: explicit ports are not allowed".to_string());
    }
    let host = url
        .host_str()
        .map(|value| value.trim_matches(['[', ']']).to_ascii_lowercase())
        .ok_or_else(|| "fetch_content blocked: URL host is required".to_string())?;
    if host == "localhost"
        || host.ends_with(".localhost")
        || host.ends_with(".local")
        || host.ends_with(".internal")
        || host == "metadata.google.internal"
    {
        return Err("fetch_content blocked: local hostname".to_string());
    }
    let port = url.port_or_known_default().unwrap_or(443);
    let addresses = (host.as_str(), port)
        .to_socket_addrs()
        .map_err(|error| format!("fetch_content DNS lookup failed: {error}"))?
        .collect::<Vec<_>>();
    if addresses.is_empty() {
        return Err("fetch_content DNS lookup returned no addresses".to_string());
    }
    if addresses
        .iter()
        .any(|address| !is_public_external_ip(address.ip()))
    {
        return Err("fetch_content blocked: DNS resolved to a non-public address".to_string());
    }
    Ok((host, addresses[0]))
}

pub(super) fn is_public_external_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            let octets = ip.octets();
            !(ip.is_private()
                || ip.is_loopback()
                || ip.is_link_local()
                || ip.is_multicast()
                || ip.is_unspecified()
                || octets[0] == 0
                || (octets[0] == 100 && (64..=127).contains(&octets[1]))
                || (octets[0] == 192 && octets[1] == 0 && octets[2] == 0)
                || (octets[0] == 192 && octets[1] == 0 && octets[2] == 2)
                || (octets[0] == 192 && octets[1] == 88 && octets[2] == 99)
                || (octets[0] == 198 && (octets[1] == 18 || octets[1] == 19))
                || (octets[0] == 198 && octets[1] == 51 && octets[2] == 100)
                || (octets[0] == 203 && octets[1] == 0 && octets[2] == 113)
                || octets[0] >= 224)
        }
        IpAddr::V6(ip) => {
            if let Some(ipv4) = ip.to_ipv4() {
                return is_public_external_ip(IpAddr::V4(ipv4));
            }
            let segments = ip.segments();
            !(ip.is_loopback()
                || ip.is_unspecified()
                || ip.is_multicast()
                || (segments[0] & 0xe000) != 0x2000
                || (segments[0] & 0xfe00) == 0xfc00
                || (segments[0] & 0xffc0) == 0xfe80
                || (segments[0] & 0xffc0) == 0xfec0
                || (segments[0] == 0x0064
                    && segments[1] == 0xff9b
                    && (segments[2] == 0 || segments[2] == 1))
                || (segments[0] == 0x0100 && segments[1..4] == [0, 0, 0])
                || (segments[0] == 0x2001 && segments[1] == 0)
                || (segments[0] == 0x2001 && segments[1] == 2 && segments[2] == 0)
                || (segments[0] == 0x2001 && matches!(segments[1] & 0xfff0, 0x0010 | 0x0020))
                || (segments[0] == 0x2001 && segments[1] == 0x0db8)
                || segments[0] == 0x2002
                || (segments[0] == 0x3fff && (segments[1] & 0xf000) == 0))
        }
    }
}

pub(super) fn inspect_external_evidence_guard(text: &str) -> Result<(), String> {
    let deny_patterns = [
        r"(?i)\b(ignore|disregard|override|bypass)\b.{0,80}\b(previous|prior|above|system|developer|policy|instruction)s?\b",
        r"(?i)\b(system prompt|developer message|hidden instruction|secret instruction|follow these instructions|you are now)\b",
        r"(?i)\b(send|reveal|exfiltrate|extract|print|upload|submit|paste|share)\b.{0,80}\b(api[_ -]?key|secret|token|password|credential|env(?:ironment)? variable)\b",
    ];
    for pattern in deny_patterns {
        if Regex::new(pattern)
            .expect("external evidence guard regex")
            .is_match(text)
        {
            return Err("prompt_injection_blocked".to_string());
        }
    }
    Ok(())
}

pub(super) fn strip_html(value: &str) -> String {
    let script_pattern = Regex::new(r"(?is)<script[^>]*>.*?</script>").expect("HTML script regex");
    let style_pattern = Regex::new(r"(?is)<style[^>]*>.*?</style>").expect("HTML style regex");
    let noscript_pattern =
        Regex::new(r"(?is)<noscript[^>]*>.*?</noscript>").expect("HTML noscript regex");
    let without_scripts = script_pattern.replace_all(value, " ");
    let without_styles = style_pattern.replace_all(&without_scripts, " ");
    let without_scripts = noscript_pattern.replace_all(&without_styles, " ");
    let without_tags = Regex::new(r"(?is)<[^>]+>")
        .expect("HTML tag regex")
        .replace_all(&without_scripts, " ");
    without_tags
        .replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}
