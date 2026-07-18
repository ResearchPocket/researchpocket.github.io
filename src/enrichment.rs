use std::env;
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use reqwest::header::{ACCEPT, CONTENT_TYPE, LOCATION};
use reqwest::{Client, Response, StatusCode, redirect};
use research_store::EnrichmentProvider;
use scraper::{Html, Selector};
use serde::{Deserialize, Serialize};
use serde_json::json;
use thiserror::Error;
use url::{Host, Url};

const CONFIG_SCHEMA_VERSION: u8 = 1;
const CONFIG_FILE: &str = "enrichment.json";
const FIRECRAWL_KEY_FILE: &str = "firecrawl.key";
const FIRECRAWL_KEY_ENV: &str = "FIRECRAWL_API_KEY";
const FIRECRAWL_API_ENV: &str = "FIRECRAWL_API_URL";
const FIRECRAWL_DEFAULT_API: &str = "https://api.firecrawl.dev";
const MAX_CONFIG_BYTES: u64 = 64 * 1024;
const MAX_KEY_BYTES: u64 = 16 * 1024;
const MAX_DIRECT_BODY_BYTES: usize = 2 * 1024 * 1024;
const MAX_FIRECRAWL_BODY_BYTES: usize = 2 * 1024 * 1024;
const MAX_REDIRECTS: usize = 5;
const MAX_TITLE_BYTES: usize = 4 * 1024;
const MAX_EXCERPT_BYTES: usize = 8 * 1024;
const MAX_LANGUAGE_BYTES: usize = 128;

pub type EnrichmentResult<T> = Result<T, EnrichmentError>;

#[derive(Debug, Error)]
pub enum EnrichmentError {
    #[error("enrichment configuration is invalid")]
    InvalidConfiguration,
    #[error("enrichment filesystem operation failed")]
    Filesystem(#[source] io::Error),
    #[error("the enrichment target URL is invalid")]
    InvalidUrl,
    #[error("the direct enrichment target is not a public network address")]
    UnsafeTarget,
    #[error("the enrichment target could not be resolved safely")]
    DnsFailure,
    #[error("the enrichment request timed out")]
    RequestTimeout,
    #[error("the enrichment request failed")]
    NetworkFailure,
    #[error("the enrichment target redirected too many times")]
    TooManyRedirects,
    #[error("the enrichment provider returned an unsuccessful status")]
    HttpStatus,
    #[error("the enrichment provider is rate limited")]
    RateLimited,
    #[error("the direct enrichment target did not return HTML")]
    UnsupportedContentType,
    #[error("the enrichment response exceeded the local size limit")]
    ResponseTooLarge,
    #[error("the Firecrawl API key is not available")]
    MissingCredential,
    #[error("the enrichment provider returned an invalid response")]
    InvalidResponse,
}

impl EnrichmentError {
    pub fn kind(&self) -> &'static str {
        match self {
            Self::InvalidConfiguration => "invalid_configuration",
            Self::Filesystem(_) => "filesystem_error",
            Self::InvalidUrl => "invalid_url",
            Self::UnsafeTarget => "unsafe_target",
            Self::DnsFailure => "dns_failure",
            Self::RequestTimeout => "request_timeout",
            Self::NetworkFailure => "network_failure",
            Self::TooManyRedirects => "too_many_redirects",
            Self::HttpStatus => "http_status",
            Self::RateLimited => "rate_limited",
            Self::UnsupportedContentType => "unsupported_content_type",
            Self::ResponseTooLarge => "response_too_large",
            Self::MissingCredential => "missing_credential",
            Self::InvalidResponse => "invalid_response",
        }
    }
}

impl From<io::Error> for EnrichmentError {
    fn from(error: io::Error) -> Self {
        Self::Filesystem(error)
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct EnrichmentStatus {
    pub configured: bool,
    pub provider: Option<EnrichmentProvider>,
    pub on_capture: bool,
    pub api_base: Option<String>,
    pub credential_available: bool,
    pub credential_source: Option<&'static str>,
}

#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize)]
pub struct EnrichmentCandidates {
    pub title: Option<String>,
    pub excerpt: Option<String>,
    pub language: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct EnrichmentConfiguration {
    schema_version: u8,
    provider: EnrichmentProvider,
    on_capture: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    firecrawl_api_base: Option<String>,
}

pub fn configure(
    data_dir: &Path,
    provider: EnrichmentProvider,
    on_capture: bool,
    api_base: Option<&str>,
    firecrawl_key: Option<&str>,
) -> EnrichmentResult<EnrichmentStatus> {
    fs::create_dir_all(data_dir)?;
    let firecrawl_api_base = match provider {
        EnrichmentProvider::Direct => {
            if api_base.is_some() || firecrawl_key.is_some() {
                return Err(EnrichmentError::InvalidConfiguration);
            }
            remove_if_exists(&key_path(data_dir))?;
            None
        }
        EnrichmentProvider::Firecrawl => {
            let api_base = api_base.map(validate_api_base).transpose()?;
            if let Some(key) = firecrawl_key {
                validate_api_key(key)?;
                atomic_private_write(&key_path(data_dir), key.as_bytes())?;
            }
            api_base
        }
    };
    let configuration = EnrichmentConfiguration {
        schema_version: CONFIG_SCHEMA_VERSION,
        provider,
        on_capture,
        firecrawl_api_base,
    };
    let mut encoded = serde_json::to_vec_pretty(&configuration)
        .map_err(|_| EnrichmentError::InvalidConfiguration)?;
    encoded.push(b'\n');
    atomic_private_write(&config_path(data_dir), &encoded)?;
    status(data_dir)
}

pub fn status(data_dir: &Path) -> EnrichmentResult<EnrichmentStatus> {
    let Some(configuration) = read_configuration(data_dir)? else {
        return Ok(disabled_status());
    };
    match configuration.provider {
        EnrichmentProvider::Direct => Ok(EnrichmentStatus {
            configured: true,
            provider: Some(EnrichmentProvider::Direct),
            on_capture: configuration.on_capture,
            api_base: None,
            credential_available: false,
            credential_source: None,
        }),
        EnrichmentProvider::Firecrawl => {
            let api_base = runtime_api_base(Some(&configuration))?;
            let credential = runtime_firecrawl_key(data_dir)?;
            Ok(EnrichmentStatus {
                configured: true,
                provider: Some(EnrichmentProvider::Firecrawl),
                on_capture: configuration.on_capture,
                api_base: Some(api_base),
                credential_available: credential.is_some(),
                credential_source: credential.map(|(_, source)| source),
            })
        }
    }
}

pub fn disable(data_dir: &Path) -> EnrichmentResult<EnrichmentStatus> {
    remove_if_exists(&config_path(data_dir))?;
    remove_if_exists(&key_path(data_dir))?;
    Ok(disabled_status())
}

pub async fn extract(
    data_dir: &Path,
    provider: EnrichmentProvider,
    url: &str,
) -> EnrichmentResult<EnrichmentCandidates> {
    match provider {
        EnrichmentProvider::Direct => direct_extract(url).await,
        EnrichmentProvider::Firecrawl => firecrawl_extract(data_dir, url).await,
    }
}

fn disabled_status() -> EnrichmentStatus {
    EnrichmentStatus {
        configured: false,
        provider: None,
        on_capture: false,
        api_base: None,
        credential_available: false,
        credential_source: None,
    }
}

async fn direct_extract(url: &str) -> EnrichmentResult<EnrichmentCandidates> {
    let target = parse_target_url(url)?;
    tokio::time::timeout(Duration::from_secs(30), direct_extract_inner(target))
        .await
        .map_err(|_| EnrichmentError::RequestTimeout)?
}

async fn direct_extract_inner(mut target: Url) -> EnrichmentResult<EnrichmentCandidates> {
    target.set_fragment(None);
    for redirect_count in 0..=MAX_REDIRECTS {
        let client = pinned_direct_client(&target).await?;
        let mut response = client
            .get(target.clone())
            .header(ACCEPT, "text/html, application/xhtml+xml;q=0.9")
            .send()
            .await
            .map_err(map_request_error)?;

        if response.status().is_redirection() {
            if redirect_count == MAX_REDIRECTS {
                return Err(EnrichmentError::TooManyRedirects);
            }
            let location = response
                .headers()
                .get(LOCATION)
                .and_then(|value| value.to_str().ok())
                .ok_or(EnrichmentError::InvalidResponse)?;
            let next = target
                .join(location)
                .map_err(|_| EnrichmentError::InvalidUrl)?;
            if target.scheme() == "https" && next.scheme() != "https" {
                return Err(EnrichmentError::UnsafeTarget);
            }
            target = parse_target_url(next.as_str())?;
            target.set_fragment(None);
            continue;
        }
        if response.status() == StatusCode::TOO_MANY_REQUESTS {
            return Err(EnrichmentError::RateLimited);
        }
        if !response.status().is_success() {
            return Err(EnrichmentError::HttpStatus);
        }
        validate_html_content_type(&response)?;
        let body = read_bounded_body(&mut response, MAX_DIRECT_BODY_BYTES).await?;
        return Ok(extract_html_metadata(&body));
    }
    Err(EnrichmentError::TooManyRedirects)
}

async fn pinned_direct_client(target: &Url) -> EnrichmentResult<Client> {
    let host = target.host().ok_or(EnrichmentError::InvalidUrl)?;
    let port = target
        .port_or_known_default()
        .ok_or(EnrichmentError::InvalidUrl)?;
    let (domain, addresses) = match host {
        Host::Ipv4(address) => {
            if !is_public_ip(IpAddr::V4(address)) {
                return Err(EnrichmentError::UnsafeTarget);
            }
            (None, Vec::new())
        }
        Host::Ipv6(address) => {
            if !is_public_ip(IpAddr::V6(address)) {
                return Err(EnrichmentError::UnsafeTarget);
            }
            (None, Vec::new())
        }
        Host::Domain(domain) => {
            validate_public_hostname(domain)?;
            let owned_domain = domain.to_owned();
            let lookup_domain = owned_domain.clone();
            let addresses = tokio::task::spawn_blocking(move || {
                (lookup_domain.as_str(), port)
                    .to_socket_addrs()
                    .map(|addresses| addresses.collect::<Vec<_>>())
            })
            .await
            .map_err(|_| EnrichmentError::DnsFailure)?
            .map_err(|_| EnrichmentError::DnsFailure)?;
            if addresses.is_empty()
                || addresses.iter().any(|address| !is_public_ip(address.ip()))
            {
                return Err(EnrichmentError::UnsafeTarget);
            }
            (Some(owned_domain), addresses)
        }
    };

    let mut builder = Client::builder()
        .redirect(redirect::Policy::none())
        .referer(false)
        .no_proxy()
        .no_gzip()
        .no_brotli()
        .no_deflate()
        .no_zstd()
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(15))
        .user_agent(concat!("ResearchPocket/", env!("CARGO_PKG_VERSION")));
    if let Some(domain) = domain {
        builder = builder.resolve_to_addrs(&domain, &addresses);
    }
    builder.build().map_err(|_| EnrichmentError::NetworkFailure)
}

async fn firecrawl_extract(
    data_dir: &Path,
    target_url: &str,
) -> EnrichmentResult<EnrichmentCandidates> {
    let mut target = parse_target_url(target_url)?;
    target.set_fragment(None);
    let configuration = read_configuration(data_dir)?;
    let api_base = runtime_api_base(configuration.as_ref())?;
    let (api_key, _) =
        runtime_firecrawl_key(data_dir)?.ok_or(EnrichmentError::MissingCredential)?;
    let endpoint = format!("{api_base}/v2/scrape");
    let client = Client::builder()
        .redirect(redirect::Policy::none())
        .referer(false)
        .no_proxy()
        .no_gzip()
        .no_brotli()
        .no_deflate()
        .no_zstd()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(45))
        .user_agent(concat!("ResearchPocket/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|_| EnrichmentError::NetworkFailure)?;
    let mut response = client
        .post(endpoint)
        .bearer_auth(api_key)
        .header(ACCEPT, "application/json")
        .json(&json!({
            "url": target.as_str(),
            "formats": ["markdown"],
            "onlyMainContent": true,
            "skipTlsVerification": false,
            "timeout": 30_000,
            "proxy": "basic",
            "storeInCache": false
        }))
        .send()
        .await
        .map_err(map_request_error)?;
    if response.status() == StatusCode::TOO_MANY_REQUESTS {
        return Err(EnrichmentError::RateLimited);
    }
    if !response.status().is_success() {
        return Err(EnrichmentError::HttpStatus);
    }
    let content_type = response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.split(';').next().unwrap_or_default().trim())
        .unwrap_or_default();
    if !content_type.eq_ignore_ascii_case("application/json") {
        return Err(EnrichmentError::InvalidResponse);
    }
    let body = read_bounded_body(&mut response, MAX_FIRECRAWL_BODY_BYTES).await?;
    let payload: FirecrawlResponse =
        serde_json::from_slice(&body).map_err(|_| EnrichmentError::InvalidResponse)?;
    if !payload.success {
        return Err(EnrichmentError::InvalidResponse);
    }
    let metadata = payload
        .data
        .and_then(|data| data.metadata)
        .ok_or(EnrichmentError::InvalidResponse)?;
    Ok(EnrichmentCandidates {
        title: normalized_candidate(metadata.title, MAX_TITLE_BYTES),
        excerpt: normalized_candidate(metadata.description, MAX_EXCERPT_BYTES),
        language: normalized_candidate(metadata.language, MAX_LANGUAGE_BYTES),
    })
}

#[derive(Deserialize)]
struct FirecrawlResponse {
    success: bool,
    data: Option<FirecrawlData>,
}

#[derive(Deserialize)]
struct FirecrawlData {
    metadata: Option<FirecrawlMetadata>,
}

#[derive(Deserialize)]
struct FirecrawlMetadata {
    title: Option<String>,
    description: Option<String>,
    language: Option<String>,
}

async fn read_bounded_body(
    response: &mut Response,
    maximum: usize,
) -> EnrichmentResult<Vec<u8>> {
    if response
        .content_length()
        .is_some_and(|length| length > maximum as u64)
    {
        return Err(EnrichmentError::ResponseTooLarge);
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(map_request_error)? {
        if body.len().saturating_add(chunk.len()) > maximum {
            return Err(EnrichmentError::ResponseTooLarge);
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

fn validate_html_content_type(response: &Response) -> EnrichmentResult<()> {
    let content_type = response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.split(';').next().unwrap_or_default().trim())
        .ok_or(EnrichmentError::UnsupportedContentType)?;
    if content_type.eq_ignore_ascii_case("text/html")
        || content_type.eq_ignore_ascii_case("application/xhtml+xml")
    {
        Ok(())
    } else {
        Err(EnrichmentError::UnsupportedContentType)
    }
}

fn extract_html_metadata(body: &[u8]) -> EnrichmentCandidates {
    let decoded = String::from_utf8_lossy(body);
    let document = Html::parse_document(&decoded);
    let title = normalized_candidate(
        meta_content(&document, "property", "og:title"),
        MAX_TITLE_BYTES,
    )
    .or_else(|| {
        let selector = Selector::parse("title").ok()?;
        let text = document
            .select(&selector)
            .next()?
            .text()
            .collect::<Vec<_>>()
            .join(" ");
        normalized_candidate(Some(text), MAX_TITLE_BYTES)
    });
    let excerpt = normalized_candidate(
        meta_content(&document, "property", "og:description"),
        MAX_EXCERPT_BYTES,
    )
    .or_else(|| {
        normalized_candidate(
            meta_content(&document, "name", "description"),
            MAX_EXCERPT_BYTES,
        )
    });
    let language = Selector::parse("html")
        .ok()
        .and_then(|selector| document.select(&selector).next())
        .and_then(|element| element.value().attr("lang"))
        .map(str::to_owned)
        .and_then(|value| normalized_candidate(Some(value), MAX_LANGUAGE_BYTES));
    EnrichmentCandidates {
        title,
        excerpt,
        language,
    }
}

fn meta_content(document: &Html, attribute: &str, expected: &str) -> Option<String> {
    let selector = Selector::parse("meta").ok()?;
    document.select(&selector).find_map(|element| {
        let value = element.value();
        value
            .attr(attribute)
            .is_some_and(|candidate| candidate.eq_ignore_ascii_case(expected))
            .then(|| value.attr("content").map(str::to_owned))
            .flatten()
    })
}

fn normalized_candidate(value: Option<String>, maximum: usize) -> Option<String> {
    let value = value?;
    let sanitized = value
        .chars()
        .map(|character| {
            if character.is_control() {
                ' '
            } else {
                character
            }
        })
        .collect::<String>();
    let normalized = sanitized.split_whitespace().collect::<Vec<_>>().join(" ");
    if normalized.is_empty() {
        return None;
    }
    Some(truncate_utf8(&normalized, maximum))
}

fn truncate_utf8(value: &str, maximum: usize) -> String {
    if value.len() <= maximum {
        return value.to_owned();
    }
    let mut boundary = maximum;
    while !value.is_char_boundary(boundary) {
        boundary -= 1;
    }
    value[..boundary].to_owned()
}

fn parse_target_url(value: &str) -> EnrichmentResult<Url> {
    let url = Url::parse(value).map_err(|_| EnrichmentError::InvalidUrl)?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(EnrichmentError::InvalidUrl);
    }
    Ok(url)
}

fn validate_public_hostname(host: &str) -> EnrichmentResult<()> {
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    if host.is_empty()
        || host == "localhost"
        || host.ends_with(".localhost")
        || host.ends_with(".local")
        || host.ends_with(".internal")
        || host == "onion"
        || host.ends_with(".onion")
        || host == "alt"
        || host.ends_with(".alt")
        || host == "arpa"
        || host.ends_with(".arpa")
        || host == "home.arpa"
        || host.ends_with(".home.arpa")
        || host == "metadata.google.internal"
        || host.ends_with(".metadata.google.internal")
        || host.ends_with(".test")
        || host.ends_with(".invalid")
        || host.ends_with(".example")
    {
        Err(EnrichmentError::UnsafeTarget)
    } else {
        Ok(())
    }
}

fn is_public_ip(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(address) => is_public_ipv4(address),
        IpAddr::V6(address) => {
            if let Some(mapped) = address.to_ipv4_mapped() {
                return is_public_ipv4(mapped);
            }
            is_public_ipv6(address)
        }
    }
}

fn is_public_ipv4(address: Ipv4Addr) -> bool {
    let [first, second, third, _] = address.octets();
    !(first == 0
        || first == 10
        || first == 127
        || (first == 100 && (64..=127).contains(&second))
        || (first == 169 && second == 254)
        || (first == 172 && (16..=31).contains(&second))
        || (first == 192 && second == 0 && third == 0)
        || (first == 192 && second == 0 && third == 2)
        || (first == 192 && second == 88 && third == 99)
        || (first == 192 && second == 168)
        || (first == 198 && (second == 18 || second == 19))
        || (first == 198 && second == 51 && third == 100)
        || (first == 203 && second == 0 && third == 113)
        || first >= 224)
}

fn is_public_ipv6(address: Ipv6Addr) -> bool {
    let segments = address.segments();
    !(address.is_unspecified()
        || address.is_loopback()
        || (segments[0] & 0xfe00) == 0xfc00
        || (segments[0] & 0xffc0) == 0xfe80
        || (segments[0] & 0xffc0) == 0xfec0
        || (segments[0] & 0xff00) == 0xff00
        // Conservatively reject the full translation block, including the
        // well-known /96 and local-use 64:ff9b:1::/48 NAT64 prefixes.
        || (segments[0] == 0x0064 && segments[1] == 0xff9b)
        || (segments[0] == 0x0100 && segments[1] == 0)
        || (segments[0] == 0x2001 && segments[1] <= 0x01ff)
        || (segments[0] == 0x2001 && segments[1] == 0x0db8)
        || segments[0] == 0x2002
        || segments[0] == 0x3ffe
        || segments[0] == 0x5f00)
}

fn map_request_error(error: reqwest::Error) -> EnrichmentError {
    if error.is_timeout() {
        EnrichmentError::RequestTimeout
    } else {
        EnrichmentError::NetworkFailure
    }
}

fn runtime_api_base(
    configuration: Option<&EnrichmentConfiguration>,
) -> EnrichmentResult<String> {
    if let Some(value) = env::var_os(FIRECRAWL_API_ENV) {
        let value = value
            .into_string()
            .map_err(|_| EnrichmentError::InvalidConfiguration)?;
        return validate_api_base(&value);
    }
    if let Some(value) = configuration
        .filter(|configuration| configuration.provider == EnrichmentProvider::Firecrawl)
        .and_then(|configuration| configuration.firecrawl_api_base.as_deref())
    {
        return validate_api_base(value);
    }
    Ok(FIRECRAWL_DEFAULT_API.to_owned())
}

fn validate_api_base(value: &str) -> EnrichmentResult<String> {
    let parsed = Url::parse(value).map_err(|_| EnrichmentError::InvalidConfiguration)?;
    let http_loopback = parsed.scheme() == "http" && api_host_is_loopback(&parsed);
    if !(parsed.scheme() == "https" || http_loopback)
        || parsed.host().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
        || parsed.path() != "/"
    {
        return Err(EnrichmentError::InvalidConfiguration);
    }
    Ok(value.trim_end_matches('/').to_owned())
}

fn api_host_is_loopback(url: &Url) -> bool {
    match url.host() {
        Some(Host::Domain(domain)) => domain.eq_ignore_ascii_case("localhost"),
        Some(Host::Ipv4(address)) => address.is_loopback(),
        Some(Host::Ipv6(address)) => address.is_loopback(),
        None => false,
    }
}

fn runtime_firecrawl_key(data_dir: &Path) -> EnrichmentResult<Option<(String, &'static str)>> {
    if let Some(value) = env::var_os(FIRECRAWL_KEY_ENV) {
        let value = value
            .into_string()
            .map_err(|_| EnrichmentError::InvalidConfiguration)?;
        validate_api_key(&value)?;
        return Ok(Some((value, "environment")));
    }
    let path = key_path(data_dir);
    let Some(value) = read_bounded_text(&path, MAX_KEY_BYTES)? else {
        return Ok(None);
    };
    validate_api_key(&value)?;
    Ok(Some((value, "key_file")))
}

fn validate_api_key(value: &str) -> EnrichmentResult<()> {
    if value.is_empty()
        || value.len() as u64 > MAX_KEY_BYTES
        || value.chars().any(char::is_whitespace)
        || value.chars().any(char::is_control)
    {
        Err(EnrichmentError::InvalidConfiguration)
    } else {
        Ok(())
    }
}

fn read_configuration(data_dir: &Path) -> EnrichmentResult<Option<EnrichmentConfiguration>> {
    let path = config_path(data_dir);
    let Some(value) = read_bounded_text(&path, MAX_CONFIG_BYTES)? else {
        return Ok(None);
    };
    let configuration: EnrichmentConfiguration =
        serde_json::from_str(&value).map_err(|_| EnrichmentError::InvalidConfiguration)?;
    if configuration.schema_version != CONFIG_SCHEMA_VERSION
        || (configuration.provider == EnrichmentProvider::Direct
            && configuration.firecrawl_api_base.is_some())
    {
        return Err(EnrichmentError::InvalidConfiguration);
    }
    if let Some(api_base) = configuration.firecrawl_api_base.as_deref() {
        validate_api_base(api_base)?;
    }
    Ok(Some(configuration))
}

fn read_bounded_text(path: &Path, maximum: u64) -> EnrichmentResult<Option<String>> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    if !metadata.file_type().is_file() || metadata.len() > maximum {
        return Err(EnrichmentError::InvalidConfiguration);
    }
    fs::read_to_string(path)
        .map(Some)
        .map_err(EnrichmentError::from)
}

fn atomic_private_write(path: &Path, value: &[u8]) -> EnrichmentResult<()> {
    let parent = path.parent().ok_or(EnrichmentError::InvalidConfiguration)?;
    fs::create_dir_all(parent)?;
    let temporary = temporary_path(path)?;
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let result = (|| -> EnrichmentResult<()> {
        let mut file = options.open(&temporary)?;
        file.write_all(value)?;
        file.sync_all()?;
        #[cfg(windows)]
        remove_if_exists(path)?;
        fs::rename(&temporary, path)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn temporary_path(path: &Path) -> EnrichmentResult<PathBuf> {
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or(EnrichmentError::InvalidConfiguration)?;
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| EnrichmentError::InvalidConfiguration)?
        .as_nanos();
    Ok(path.with_file_name(format!(".{name}.{}.{}.tmp", std::process::id(), nonce)))
}

fn remove_if_exists(path: &Path) -> EnrichmentResult<()> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

fn config_path(data_dir: &Path) -> PathBuf {
    data_dir.join(CONFIG_FILE)
}

fn key_path(data_dir: &Path) -> PathBuf {
    data_dir.join(FIRECRAWL_KEY_FILE)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn private_networks_are_rejected_and_credentials_stay_separate() {
        for address in [
            IpAddr::V4(Ipv4Addr::LOCALHOST),
            IpAddr::V4(Ipv4Addr::new(10, 0, 0, 1)),
            IpAddr::V4(Ipv4Addr::new(169, 254, 169, 254)),
            IpAddr::V4(Ipv4Addr::new(192, 0, 2, 1)),
            IpAddr::V6(Ipv6Addr::LOCALHOST),
            "fc00::1".parse().expect("ULA address"),
            "fec0::1".parse().expect("deprecated site-local address"),
            "64:ff9b:1::1".parse().expect("local-use NAT64 address"),
            "2001::1".parse().expect("Teredo address"),
            "2001:db8::1".parse().expect("documentation address"),
        ] {
            assert!(!is_public_ip(address), "{address} must remain blocked");
        }
        assert!(is_public_ip(IpAddr::V4(Ipv4Addr::new(1, 1, 1, 1))));
        assert!(is_public_ip(
            "2606:4700:4700::1111".parse().expect("public IPv6 address")
        ));

        let metadata = extract_html_metadata(
            br#"<html lang="en"><head><title> Fallback title </title><meta property="og:title" content=""><meta name="description" content="Useful summary"></head></html>"#,
        );
        assert_eq!(metadata.title.as_deref(), Some("Fallback title"));
        assert_eq!(metadata.excerpt.as_deref(), Some("Useful summary"));
        assert_eq!(metadata.language.as_deref(), Some("en"));

        let directory = tempfile::tempdir().expect("temporary data directory");
        let secret = "fc-test-secret";
        configure(
            directory.path(),
            EnrichmentProvider::Firecrawl,
            true,
            None,
            Some(secret),
        )
        .expect("configure Firecrawl");
        let configuration = fs::read_to_string(config_path(directory.path()))
            .expect("read non-secret configuration");
        assert!(!configuration.contains(secret));
        assert_eq!(
            fs::read_to_string(key_path(directory.path())).expect("read separate key"),
            secret
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(key_path(directory.path()))
                .expect("key metadata")
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(mode, 0o600);
        }
        disable(directory.path()).expect("disable enrichment");
        assert!(!config_path(directory.path()).exists());
        assert!(!key_path(directory.path()).exists());
    }
}
