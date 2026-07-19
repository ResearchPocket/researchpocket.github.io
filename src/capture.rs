use std::env;
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use directories::ProjectDirs;
use research_domain::validate_item_url;
use research_store::{CreateItemRequest, EnrichmentProvider, StoreError, StoredItem, V2Store};
use serde::{Deserialize, Serialize};
use thiserror::Error;
use url::Url;

const CAPTURE_SCHEME: &str = "researchpocket";
const CAPTURE_HOST: &str = "capture";
const CAPTURE_VERSION_V1: &str = "1";
const CAPTURE_VERSION_V2: &str = "2";
const MAX_CAPTURE_URI_BYTES: usize = 64 * 1024;
const MAX_PAGE_URL_BYTES: usize = 32 * 1024;
const MAX_TITLE_BYTES: usize = 4 * 1024;
const MAX_EXCERPT_BYTES: usize = 8 * 1024;
const MAX_LANGUAGE_BYTES: usize = 128;
const MAX_NOTE_BYTES: usize = 32 * 1024;
const MAX_TAGS: usize = 64;
const MAX_TAG_BYTES: usize = 1024;
const REGISTRATION_SCHEMA_VERSION: u8 = 1;
const REGISTRATION_FILE: &str = "capture-handler.json";
const NOTIFICATION_SECRET_ENV_VARS: [&str; 6] = [
    "FIRECRAWL_API_KEY",
    "RESEARCHPOCKET_GITHUB_TOKEN",
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "GH_ENTERPRISE_TOKEN",
    "GITHUB_ENTERPRISE_TOKEN",
];

#[derive(Debug, Error)]
pub enum CaptureError {
    #[error("invalid capture URI: {0}")]
    InvalidUri(String),
    #[error("capture handler registration failed: {0}")]
    Registration(String),
    #[error("filesystem operation failed: {0}")]
    Io(#[from] io::Error),
    #[error("JSON operation failed: {0}")]
    Json(#[from] serde_json::Error),
    #[error(transparent)]
    Store(#[from] StoreError),
}

pub type CaptureResult<T> = Result<T, CaptureError>;

#[derive(Clone, Debug, Eq, PartialEq)]
struct CaptureRequest {
    url: String,
    title: Option<String>,
    excerpt: Option<String>,
    note: String,
    favorite: bool,
    language: Option<String>,
    tags: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
struct RegistrationManifest {
    schema_version: u8,
    scheme: String,
    binary_version: String,
    executable: PathBuf,
    data_dir: PathBuf,
}

#[derive(Clone, Debug, Serialize)]
pub struct RegistrationStatus {
    pub installed: bool,
    pub scheme: &'static str,
    pub executable: Option<String>,
    pub data_dir: Option<String>,
}

/// Install or refresh the current user's capture handler for this exact library.
pub async fn install(data_dir: &Path) -> CaptureResult<RegistrationStatus> {
    // Refuse to install a handler that can only fail later in the desktop shell.
    V2Store::open(data_dir).await?;

    let executable = env::current_exe()?.canonicalize()?;
    let data_dir = data_dir.canonicalize()?;
    let manifest = RegistrationManifest {
        schema_version: REGISTRATION_SCHEMA_VERSION,
        scheme: CAPTURE_SCHEME.to_owned(),
        binary_version: env!("CARGO_PKG_VERSION").to_owned(),
        executable,
        data_dir,
    };

    platform_install(&manifest)?;
    if let Err(error) = write_manifest(&manifest) {
        let _ = platform_uninstall(Some(&manifest));
        return Err(error);
    }

    Ok(registration_status(true, Some(&manifest)))
}

/// Inspect the ResearchPocket-owned per-user registration without changing it.
pub fn status() -> CaptureResult<RegistrationStatus> {
    let manifest = read_manifest()?;
    let installed = match manifest.as_ref() {
        Some(manifest) => platform_is_registered(manifest)?,
        None => false,
    };
    Ok(registration_status(installed, manifest.as_ref()))
}

/// Remove only the current user's ResearchPocket-owned capture registration.
pub fn uninstall() -> CaptureResult<RegistrationStatus> {
    let manifest = read_manifest()?;
    platform_uninstall(manifest.as_ref())?;
    let path = manifest_path()?;
    if path.exists() {
        fs::remove_file(path)?;
    }
    Ok(registration_status(false, None))
}

/// Parse one capture URI and save it through the ordinary V2 mutation path.
pub async fn handle(
    data_dir: &Path,
    capture_uri: &str,
    send_notification: bool,
    enrichment_provider: Option<EnrichmentProvider>,
) -> CaptureResult<StoredItem> {
    let result = async {
        let request = parse_capture_uri(capture_uri)?;
        let store = V2Store::open(data_dir).await?;
        let request = CreateItemRequest {
            url: request.url,
            title: request.title,
            excerpt: request.excerpt,
            favorite: request.favorite,
            language: request.language,
            saved_at: None,
            note: request.note,
            tags: request.tags,
        };
        match enrichment_provider {
            Some(provider) => store.create_item_with_enrichment(request, provider).await,
            None => store.create_item(request).await,
        }
        .map_err(CaptureError::from)
    }
    .await;

    if send_notification {
        notify(result.is_ok());
    }
    result
}

fn parse_capture_uri(capture_uri: &str) -> CaptureResult<CaptureRequest> {
    if capture_uri.len() > MAX_CAPTURE_URI_BYTES {
        return Err(invalid_uri("capture payload is too large"));
    }
    if capture_uri.bytes().any(|byte| byte.is_ascii_control())
        || capture_uri.trim_matches(|character: char| character.is_ascii_whitespace())
            != capture_uri
    {
        return Err(invalid_uri(
            "capture URI contains disallowed raw whitespace or control characters",
        ));
    }

    let parsed = Url::parse(capture_uri).map_err(|_| invalid_uri("URI is malformed"))?;
    if parsed.scheme() != CAPTURE_SCHEME
        || parsed.host_str() != Some(CAPTURE_HOST)
        || !parsed.path().is_empty()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.port().is_some()
        || parsed.fragment().is_some()
    {
        return Err(invalid_uri(
            "expected the exact researchpocket://capture route",
        ));
    }
    validate_percent_encoding(parsed.query().unwrap_or_default())?;

    let mut version = None;
    let mut page_url = None;
    let mut title = None;
    let mut excerpt = None;
    let mut note = None;
    let mut favorite = None;
    let mut language = None;
    let mut tags = Vec::new();

    for (key, value) in parsed.query_pairs() {
        let value = value.into_owned();
        match key.as_ref() {
            "version" => set_once(&mut version, value, "version")?,
            "url" => set_once(&mut page_url, value, "url")?,
            "title" => set_once(&mut title, value, "title")?,
            "excerpt" => set_once(&mut excerpt, value, "excerpt")?,
            "note" => set_once(&mut note, value, "note")?,
            "favorite" => set_once(&mut favorite, value, "favorite")?,
            "language" => set_once(&mut language, value, "language")?,
            "tag" => {
                if tags.len() == MAX_TAGS {
                    return Err(invalid_uri("capture contains too many tags"));
                }
                if value.trim().is_empty() {
                    return Err(invalid_uri("tag cannot be blank"));
                }
                validate_text_field(&value, "tag", MAX_TAG_BYTES, false)?;
                tags.push(value);
            }
            _ => {
                return Err(invalid_uri("capture contains an unknown field"));
            }
        }
    }

    let version = version
        .as_deref()
        .ok_or_else(|| invalid_uri("version must appear once and equal 1 or 2"))?;
    if version != CAPTURE_VERSION_V1 && version != CAPTURE_VERSION_V2 {
        return Err(invalid_uri("version must appear once and equal 1 or 2"));
    }
    if version == CAPTURE_VERSION_V1 && (excerpt.is_some() || language.is_some()) {
        return Err(invalid_uri(
            "capture contains a field that is unknown to version 1",
        ));
    }
    let page_url = page_url
        .filter(|url: &String| !url.is_empty())
        .ok_or_else(|| invalid_uri("url must appear once and cannot be empty"))?;
    validate_text_field(&page_url, "url", MAX_PAGE_URL_BYTES, false)?;
    validate_item_url(&page_url)
        .map_err(|_| invalid_uri("url must be an absolute HTTP(S) URL with a host"))?;
    let target = Url::parse(&page_url)
        .map_err(|_| invalid_uri("url must be an absolute HTTP(S) URL with a host"))?;
    if !target.username().is_empty() || target.password().is_some() {
        return Err(invalid_uri("url cannot contain embedded credentials"));
    }
    if let Some(title) = title.as_deref() {
        validate_text_field(title, "title", MAX_TITLE_BYTES, false)?;
    }
    if let Some(excerpt) = excerpt.as_deref() {
        validate_text_field(excerpt, "excerpt", MAX_EXCERPT_BYTES, false)?;
    }
    if let Some(note) = note.as_deref() {
        validate_text_field(note, "note", MAX_NOTE_BYTES, true)?;
    }
    if let Some(language) = language.as_deref() {
        validate_text_field(language, "language", MAX_LANGUAGE_BYTES, false)?;
    }
    let favorite = match favorite.as_deref() {
        None | Some("false") => false,
        Some("true") => true,
        Some(_) => return Err(invalid_uri("favorite must be true or false")),
    };

    Ok(CaptureRequest {
        url: page_url,
        title,
        excerpt,
        note: note.unwrap_or_default(),
        favorite,
        language,
        tags,
    })
}

fn validate_percent_encoding(query: &str) -> CaptureResult<()> {
    let input = query.as_bytes();
    let mut decoded = Vec::with_capacity(input.len());
    let mut index = 0;
    while index < input.len() {
        if input[index] != b'%' {
            decoded.push(input[index]);
            index += 1;
            continue;
        }
        let Some((&high, tail)) = input.get(index + 1).zip(input.get(index + 2..)) else {
            return Err(invalid_uri("capture contains malformed percent encoding"));
        };
        let Some(&low) = tail.first() else {
            return Err(invalid_uri("capture contains malformed percent encoding"));
        };
        let value = hex_value(high)
            .zip(hex_value(low))
            .map(|(high, low)| high * 16 + low)
            .ok_or_else(|| invalid_uri("capture contains malformed percent encoding"))?;
        decoded.push(value);
        index += 3;
    }
    std::str::from_utf8(&decoded)
        .map(|_| ())
        .map_err(|_| invalid_uri("capture contains invalid UTF-8 percent encoding"))
}

fn hex_value(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        b'A'..=b'F' => Some(value - b'A' + 10),
        _ => None,
    }
}

fn validate_text_field(
    value: &str,
    field: &str,
    max_bytes: usize,
    allow_note_whitespace: bool,
) -> CaptureResult<()> {
    if value.len() > max_bytes {
        return Err(invalid_uri(format!("{field} is too large")));
    }
    if value.chars().any(|character| {
        character.is_control() && !(allow_note_whitespace && matches!(character, '\n' | '\t'))
    }) {
        return Err(invalid_uri(format!(
            "{field} contains a disallowed control character"
        )));
    }
    Ok(())
}

fn set_once(slot: &mut Option<String>, value: String, field: &str) -> CaptureResult<()> {
    if slot.replace(value).is_some() {
        return Err(invalid_uri(format!(
            "field {field:?} cannot appear more than once"
        )));
    }
    Ok(())
}

fn invalid_uri(message: impl Into<String>) -> CaptureError {
    CaptureError::InvalidUri(message.into())
}

fn registration_status(
    installed: bool,
    manifest: Option<&RegistrationManifest>,
) -> RegistrationStatus {
    RegistrationStatus {
        installed,
        scheme: "researchpocket://",
        executable: manifest.map(|entry| entry.executable.display().to_string()),
        data_dir: manifest.map(|entry| entry.data_dir.display().to_string()),
    }
}

fn project_dirs() -> CaptureResult<ProjectDirs> {
    ProjectDirs::from("io.github", "ResearchPocket", "ResearchPocket")
        .ok_or_else(|| CaptureError::Registration("no per-user configuration directory".into()))
}

fn manifest_path() -> CaptureResult<PathBuf> {
    Ok(project_dirs()?.config_dir().join(REGISTRATION_FILE))
}

fn read_manifest() -> CaptureResult<Option<RegistrationManifest>> {
    let path = manifest_path()?;
    if !path.is_file() {
        return Ok(None);
    }
    let manifest: RegistrationManifest = serde_json::from_slice(&fs::read(path)?)?;
    if manifest.schema_version != REGISTRATION_SCHEMA_VERSION
        || manifest.scheme != CAPTURE_SCHEME
        || manifest.binary_version.is_empty()
        || !manifest.executable.is_absolute()
        || !manifest.data_dir.is_absolute()
    {
        return Err(CaptureError::Registration(
            "capture registration metadata is invalid".into(),
        ));
    }
    Ok(Some(manifest))
}

fn write_manifest(manifest: &RegistrationManifest) -> CaptureResult<()> {
    let path = manifest_path()?;
    let parent = path.parent().ok_or_else(|| {
        CaptureError::Registration("registration path has no parent directory".into())
    })?;
    fs::create_dir_all(parent)?;
    set_private_directory(parent)?;
    write_atomic(&path, &serde_json::to_vec_pretty(manifest)?, 0o600)
}

fn write_atomic(path: &Path, bytes: &[u8], _unix_mode: u32) -> CaptureResult<()> {
    let parent = path.parent().ok_or_else(|| {
        CaptureError::Registration("registration path has no parent directory".into())
    })?;
    fs::create_dir_all(parent)?;

    let extension = format!("tmp-{}", std::process::id());
    let temporary = path.with_extension(extension);
    if temporary.exists() {
        fs::remove_file(&temporary)?;
    }

    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(_unix_mode);
    }
    let mut file = options.open(&temporary)?;
    file.write_all(bytes)?;
    file.sync_all()?;

    #[cfg(windows)]
    if path.exists() {
        fs::remove_file(path)?;
    }
    fs::rename(&temporary, path)?;
    Ok(())
}

#[cfg(unix)]
fn set_private_directory(path: &Path) -> CaptureResult<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    Ok(())
}

#[cfg(not(unix))]
fn set_private_directory(_path: &Path) -> CaptureResult<()> {
    Ok(())
}

fn path_text(path: &Path, label: &str) -> CaptureResult<String> {
    let value = path.to_str().map(str::to_owned).ok_or_else(|| {
        CaptureError::Registration(format!("{label} path is not valid Unicode"))
    })?;
    if value.chars().any(char::is_control) {
        return Err(CaptureError::Registration(format!(
            "{label} path contains a control character"
        )));
    }
    Ok(value)
}

fn run_checked(command: &mut Command, action: &str) -> CaptureResult<()> {
    let output = command.output()?;
    if output.status.success() {
        return Ok(());
    }
    let detail = String::from_utf8_lossy(&output.stderr);
    let detail = detail.trim();
    Err(CaptureError::Registration(if detail.is_empty() {
        action.to_owned()
    } else {
        format!("{action}: {detail}")
    }))
}

#[cfg(target_os = "linux")]
const LINUX_DESKTOP_ID: &str = "researchpocket-capture.desktop";

#[cfg(target_os = "linux")]
fn linux_desktop_path() -> CaptureResult<PathBuf> {
    let base = directories::BaseDirs::new().ok_or_else(|| {
        CaptureError::Registration("no per-user application data directory".into())
    })?;
    Ok(base.data_dir().join("applications").join(LINUX_DESKTOP_ID))
}

#[cfg(target_os = "linux")]
fn linux_desktop_entry(manifest: &RegistrationManifest) -> CaptureResult<String> {
    let executable = desktop_quote(&path_text(&manifest.executable, "executable")?);
    let data_dir = desktop_quote(&path_text(&manifest.data_dir, "data directory")?);
    Ok(format!(
        "[Desktop Entry]\nType=Application\nVersion=1.0\nName=ResearchPocket Capture\nNoDisplay=true\nTerminal=false\nExec={executable} --data-dir {data_dir} capture handle --notify -- %u\nMimeType=x-scheme-handler/researchpocket;\nX-ResearchPocket-Capture=true\n"
    ))
}

#[cfg(target_os = "linux")]
fn desktop_quote(value: &str) -> String {
    let escaped = value
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('`', "\\`")
        .replace('$', "\\$")
        .replace('%', "%%");
    format!("\"{escaped}\"")
}

#[cfg(target_os = "linux")]
fn platform_install(manifest: &RegistrationManifest) -> CaptureResult<()> {
    let desktop_path = linux_desktop_path()?;
    if desktop_path.exists()
        && !fs::read_to_string(&desktop_path)?
            .lines()
            .any(|line| line == "X-ResearchPocket-Capture=true")
    {
        return Err(CaptureError::Registration(
            "refusing to replace a desktop entry not owned by ResearchPocket".into(),
        ));
    }
    write_atomic(
        &desktop_path,
        linux_desktop_entry(manifest)?.as_bytes(),
        0o644,
    )?;
    run_checked(
        Command::new("xdg-mime").args([
            "default",
            LINUX_DESKTOP_ID,
            "x-scheme-handler/researchpocket",
        ]),
        "xdg-mime could not select the ResearchPocket handler",
    )?;
    if let Some(parent) = desktop_path.parent() {
        let _ = Command::new("update-desktop-database")
            .arg(parent)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    if !platform_is_registered(manifest)? {
        return Err(CaptureError::Registration(
            "the desktop did not retain the ResearchPocket handler".into(),
        ));
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn platform_is_registered(manifest: &RegistrationManifest) -> CaptureResult<bool> {
    let desktop_path = linux_desktop_path()?;
    if !desktop_path.is_file()
        || fs::read_to_string(&desktop_path)? != linux_desktop_entry(manifest)?
    {
        return Ok(false);
    }
    let output = Command::new("xdg-mime")
        .args(["query", "default", "x-scheme-handler/researchpocket"])
        .output()?;
    Ok(output.status.success()
        && String::from_utf8_lossy(&output.stdout).trim() == LINUX_DESKTOP_ID)
}

#[cfg(target_os = "linux")]
fn platform_uninstall(manifest: Option<&RegistrationManifest>) -> CaptureResult<()> {
    let desktop_path = linux_desktop_path()?;
    if !desktop_path.exists() {
        return Ok(());
    }
    let content = fs::read_to_string(&desktop_path)?;
    let owned = manifest
        .map(linux_desktop_entry)
        .transpose()?
        .is_some_and(|expected| expected == content)
        || content
            .lines()
            .any(|line| line == "X-ResearchPocket-Capture=true");
    if !owned {
        return Err(CaptureError::Registration(
            "refusing to remove a desktop entry not owned by ResearchPocket".into(),
        ));
    }
    fs::remove_file(&desktop_path)?;
    if let Some(parent) = desktop_path.parent() {
        let _ = Command::new("update-desktop-database")
            .arg(parent)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    Ok(())
}

#[cfg(target_os = "macos")]
const MAC_APP_NAME: &str = "ResearchPocket Capture.app";
#[cfg(target_os = "macos")]
const MAC_BUNDLE_ID: &str = "io.github.ResearchPocket.capture";
#[cfg(target_os = "macos")]
const MAC_EXECUTABLE: &str = "research-capture-handler";

#[cfg(target_os = "macos")]
fn mac_app_path() -> CaptureResult<PathBuf> {
    let base = directories::BaseDirs::new()
        .ok_or_else(|| CaptureError::Registration("no per-user home directory".into()))?;
    Ok(base.home_dir().join("Applications").join(MAC_APP_NAME))
}

#[cfg(target_os = "macos")]
fn mac_marker_path(app: &Path) -> PathBuf {
    app.join("Contents/Resources/researchpocket-capture.json")
}

#[cfg(target_os = "macos")]
fn mac_app_owned(app: &Path, manifest: Option<&RegistrationManifest>) -> CaptureResult<bool> {
    let marker = mac_marker_path(app);
    if !marker.is_file() {
        return Ok(false);
    }
    let found: RegistrationManifest = serde_json::from_slice(&fs::read(marker)?)?;
    Ok(found.schema_version == REGISTRATION_SCHEMA_VERSION
        && found.scheme == CAPTURE_SCHEME
        && !found.binary_version.is_empty()
        && manifest.is_none_or(|expected| expected == &found))
}

#[cfg(target_os = "macos")]
fn mac_info_plist() -> String {
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "https://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key><string>en</string>
  <key>CFBundleExecutable</key><string>{MAC_EXECUTABLE}</string>
  <key>CFBundleIdentifier</key><string>{MAC_BUNDLE_ID}</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>ResearchPocket Capture</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>{}</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>LSUIElement</key><true/>
  <key>CFBundleURLTypes</key>
  <array><dict>
    <key>CFBundleURLName</key><string>ResearchPocket Capture</string>
    <key>CFBundleURLSchemes</key><array><string>researchpocket</string></array>
  </dict></array>
</dict>
</plist>
"#,
        env!("CARGO_PKG_VERSION")
    )
}

#[cfg(target_os = "macos")]
fn launch_services() -> Command {
    Command::new(
        "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister",
    )
}

#[cfg(target_os = "macos")]
fn platform_install(manifest: &RegistrationManifest) -> CaptureResult<()> {
    let app = mac_app_path()?;
    if app.exists() && !mac_app_owned(&app, None)? {
        return Err(CaptureError::Registration(format!(
            "refusing to replace an application not owned by ResearchPocket at {}",
            app.display()
        )));
    }
    let parent = app.parent().ok_or_else(|| {
        CaptureError::Registration("capture application has no parent directory".into())
    })?;
    fs::create_dir_all(parent)?;

    let staging = parent.join(format!(
        ".ResearchPocket Capture-{}.app",
        std::process::id()
    ));
    if staging.exists() {
        fs::remove_dir_all(&staging)?;
    }
    let contents = staging.join("Contents");
    let macos = contents.join("MacOS");
    let resources = contents.join("Resources");
    fs::create_dir_all(&macos)?;
    fs::create_dir_all(&resources)?;
    write_atomic(
        &contents.join("Info.plist"),
        mac_info_plist().as_bytes(),
        0o644,
    )?;
    write_atomic(
        &mac_marker_path(&staging),
        &serde_json::to_vec_pretty(manifest)?,
        0o600,
    )?;
    let bundled_executable = macos.join(MAC_EXECUTABLE);
    fs::copy(&manifest.executable, &bundled_executable)?;
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(&bundled_executable, fs::Permissions::from_mode(0o755))?;

    if app.exists() {
        fs::remove_dir_all(&app)?;
    }
    fs::rename(&staging, &app)?;
    run_checked(
        launch_services().arg("-f").arg(&app),
        "LaunchServices could not register the ResearchPocket capture application",
    )?;
    mac_set_default_handler(&app)?;
    Ok(())
}

#[cfg(target_os = "macos")]
fn platform_is_registered(manifest: &RegistrationManifest) -> CaptureResult<bool> {
    let app = mac_app_path()?;
    Ok(app.is_dir()
        && app.join("Contents/MacOS").join(MAC_EXECUTABLE).is_file()
        && manifest.binary_version == env!("CARGO_PKG_VERSION")
        && mac_app_owned(&app, Some(manifest))?
        && mac_is_effective_handler(&app)?)
}

#[cfg(target_os = "macos")]
fn platform_uninstall(manifest: Option<&RegistrationManifest>) -> CaptureResult<()> {
    let app = mac_app_path()?;
    if !app.exists() {
        return Ok(());
    }
    if !mac_app_owned(&app, manifest)? {
        return Err(CaptureError::Registration(format!(
            "refusing to remove an application not owned by ResearchPocket at {}",
            app.display()
        )));
    }
    run_checked(
        launch_services().arg("-u").arg(&app),
        "LaunchServices could not unregister the ResearchPocket capture application",
    )?;
    fs::remove_dir_all(app)?;
    Ok(())
}

#[cfg(target_os = "macos")]
fn mac_application_url(
    path: &Path,
) -> CaptureResult<objc2::rc::Retained<objc2_foundation::NSURL>> {
    let path = path_text(path, "capture application")?;
    let path = objc2_foundation::NSString::from_str(&path);
    Ok(objc2_foundation::NSURL::fileURLWithPath_isDirectory(
        &path, true,
    ))
}

#[cfg(target_os = "macos")]
fn mac_capture_url() -> CaptureResult<objc2::rc::Retained<objc2_foundation::NSURL>> {
    let value = objc2_foundation::NSString::from_str(
        "researchpocket://capture?version=1&url=https%3A%2F%2Fexample.invalid",
    );
    objc2_foundation::NSURL::URLWithString(&value)
        .ok_or_else(|| CaptureError::Registration("could not construct the capture URL".into()))
}

#[cfg(target_os = "macos")]
fn mac_set_default_handler(app: &Path) -> CaptureResult<()> {
    use std::time::{Duration, Instant};

    let workspace = objc2_app_kit::NSWorkspace::sharedWorkspace();
    let application_url = mac_application_url(app)?;
    let scheme = objc2_foundation::NSString::from_str(CAPTURE_SCHEME);
    workspace.setDefaultApplicationAtURL_toOpenURLsWithScheme_completionHandler(
        &application_url,
        &scheme,
        None,
    );

    let deadline = Instant::now() + Duration::from_secs(3);
    while Instant::now() < deadline {
        if mac_is_effective_handler(app)? {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    Err(CaptureError::Registration(
        "macOS did not select ResearchPocket as the researchpocket:// handler".into(),
    ))
}

#[cfg(target_os = "macos")]
fn mac_is_effective_handler(app: &Path) -> CaptureResult<bool> {
    let workspace = objc2_app_kit::NSWorkspace::sharedWorkspace();
    let capture_url = mac_capture_url()?;
    let Some(handler) = workspace.URLForApplicationToOpenURL(&capture_url) else {
        return Ok(false);
    };
    Ok(handler
        .path()
        .is_some_and(|path| Path::new(&path.to_string()) == app))
}

/// True only for the no-argument helper executable inside our generated app.
#[cfg(target_os = "macos")]
pub fn macos_handler_launch_requested() -> bool {
    let mut arguments = env::args_os();
    let _ = arguments.next();
    if !arguments.all(|argument| {
        argument
            .to_str()
            .is_some_and(|argument| argument.starts_with("-psn_"))
    }) {
        return false;
    }
    macos_running_manifest_path().is_some_and(|path| path.is_file())
}

#[cfg(target_os = "macos")]
fn macos_running_manifest_path() -> Option<PathBuf> {
    let executable = env::current_exe().ok()?;
    let macos = executable.parent()?;
    if macos.file_name()? != "MacOS" {
        return None;
    }
    let contents = macos.parent()?;
    if contents.file_name()? != "Contents" {
        return None;
    }
    Some(contents.join("Resources/researchpocket-capture.json"))
}

/// Run the native AppKit URL receiver used by the generated per-user app.
#[cfg(target_os = "macos")]
pub fn run_macos_handler() -> CaptureResult<()> {
    let marker = macos_running_manifest_path().ok_or_else(|| {
        CaptureError::Registration("capture helper is outside its application bundle".into())
    })?;
    let manifest: RegistrationManifest = serde_json::from_slice(&fs::read(marker)?)?;
    if manifest.schema_version != REGISTRATION_SCHEMA_VERSION
        || manifest.scheme != CAPTURE_SCHEME
        || manifest.binary_version != env!("CARGO_PKG_VERSION")
        || !manifest.data_dir.is_absolute()
    {
        return Err(CaptureError::Registration(
            "capture helper configuration is invalid".into(),
        ));
    }
    let executable = env::current_exe()?;
    macos_app::run(executable, manifest.data_dir)
}

#[cfg(target_os = "macos")]
mod macos_app {
    use std::path::PathBuf;
    use std::process::{Command, Stdio};

    use objc2::rc::Retained;
    use objc2::runtime::ProtocolObject;
    use objc2::{DefinedClass, MainThreadOnly, define_class, msg_send};
    use objc2_app_kit::{NSApplication, NSApplicationDelegate};
    use objc2_foundation::{MainThreadMarker, NSArray, NSObject, NSObjectProtocol, NSURL};

    use super::{CaptureError, CaptureResult, notify};

    #[derive(Debug)]
    struct DelegateIvars {
        executable: PathBuf,
        data_dir: PathBuf,
    }

    define_class!(
        // SAFETY: NSObject has no subclassing requirements and Delegate does not implement Drop.
        #[unsafe(super = NSObject)]
        #[thread_kind = MainThreadOnly]
        #[ivars = DelegateIvars]
        struct Delegate;

        // SAFETY: NSObjectProtocol has no additional safety requirements.
        unsafe impl NSObjectProtocol for Delegate {}

        // SAFETY: NSApplicationDelegate has no additional safety requirements.
        unsafe impl NSApplicationDelegate for Delegate {
            #[unsafe(method(application:openURLs:))]
            #[allow(non_snake_case)]
            fn application_openURLs(&self, application: &NSApplication, urls: &NSArray<NSURL>) {
                if urls.count() != 1 {
                    notify(false);
                    application.terminate(None);
                    return;
                }
                let url = urls.objectAtIndex(0);
                let Some(capture_uri) = url.absoluteString() else {
                    notify(false);
                    application.terminate(None);
                    return;
                };
                let spawned = Command::new(&self.ivars().executable)
                    .arg("--data-dir")
                    .arg(&self.ivars().data_dir)
                    .args(["capture", "handle", "--notify", "--"])
                    .arg(capture_uri.to_string())
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .spawn();
                if spawned.is_err() {
                    notify(false);
                }
                application.terminate(None);
            }
        }
    );

    impl Delegate {
        fn new(
            mtm: MainThreadMarker,
            executable: PathBuf,
            data_dir: PathBuf,
        ) -> Retained<Self> {
            let this = Self::alloc(mtm).set_ivars(DelegateIvars {
                executable,
                data_dir,
            });
            // SAFETY: The message is NSObject's correctly typed initializer.
            unsafe { msg_send![super(this), init] }
        }
    }

    pub fn run(executable: PathBuf, data_dir: PathBuf) -> CaptureResult<()> {
        let mtm = MainThreadMarker::new().ok_or_else(|| {
            CaptureError::Registration("capture helper must run on the main thread".into())
        })?;
        let application = NSApplication::sharedApplication(mtm);
        let delegate = Delegate::new(mtm, executable, data_dir);
        application.setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
        application.run();
        Ok(())
    }
}

#[cfg(target_os = "windows")]
const WINDOWS_REGISTRY_KEY: &str = r"Software\Classes\researchpocket";
#[cfg(target_os = "windows")]
const WINDOWS_OWNER_VALUE: &str = "ResearchPocket Capture Schema";

#[cfg(target_os = "windows")]
fn windows_command(manifest: &RegistrationManifest) -> CaptureResult<String> {
    Ok([
        windows_quote(&path_text(&manifest.executable, "executable")?),
        "--data-dir".into(),
        windows_quote(&path_text(&manifest.data_dir, "data directory")?),
        "capture".into(),
        "handle".into(),
        "--notify".into(),
        "--".into(),
        windows_quote("%1"),
    ]
    .join(" "))
}

#[cfg(target_os = "windows")]
fn windows_quote(value: &str) -> String {
    let mut quoted = String::from("\"");
    let mut backslashes = 0;
    for character in value.chars() {
        match character {
            '\\' => backslashes += 1,
            '"' => {
                quoted.push_str(&"\\".repeat(backslashes * 2 + 1));
                quoted.push('"');
                backslashes = 0;
            }
            _ => {
                quoted.push_str(&"\\".repeat(backslashes));
                backslashes = 0;
                quoted.push(character);
            }
        }
    }
    quoted.push_str(&"\\".repeat(backslashes * 2));
    quoted.push('"');
    quoted
}

#[cfg(target_os = "windows")]
fn platform_install(manifest: &RegistrationManifest) -> CaptureResult<()> {
    use winreg::RegKey;
    use winreg::enums::{HKEY_CURRENT_USER, KEY_READ};

    let current_user = RegKey::predef(HKEY_CURRENT_USER);
    match current_user.open_subkey_with_flags(WINDOWS_REGISTRY_KEY, KEY_READ) {
        Ok(existing) => {
            let owner: io::Result<u32> = existing.get_value(WINDOWS_OWNER_VALUE);
            if owner.ok() != Some(u32::from(REGISTRATION_SCHEMA_VERSION)) {
                return Err(CaptureError::Registration(
                    "refusing to replace a researchpocket URL scheme not owned by ResearchPocket"
                        .into(),
                ));
            }
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }

    let (root, _) = current_user.create_subkey(WINDOWS_REGISTRY_KEY)?;
    root.set_value("", &"URL:ResearchPocket Capture")?;
    root.set_value("URL Protocol", &"")?;
    root.set_value(WINDOWS_OWNER_VALUE, &u32::from(REGISTRATION_SCHEMA_VERSION))?;
    let (command, _) = root.create_subkey(r"shell\open\command")?;
    command.set_value("", &windows_command(manifest)?)?;
    windows_notify_association_change();
    Ok(())
}

#[cfg(target_os = "windows")]
fn platform_is_registered(manifest: &RegistrationManifest) -> CaptureResult<bool> {
    use winreg::RegKey;
    use winreg::enums::HKEY_CURRENT_USER;

    let current_user = RegKey::predef(HKEY_CURRENT_USER);
    let Ok(root) = current_user.open_subkey(WINDOWS_REGISTRY_KEY) else {
        return Ok(false);
    };
    let owner: io::Result<u32> = root.get_value(WINDOWS_OWNER_VALUE);
    if owner.ok() != Some(u32::from(REGISTRATION_SCHEMA_VERSION)) {
        return Ok(false);
    }
    let Ok(command) = root.open_subkey(r"shell\open\command") else {
        return Ok(false);
    };
    let registered: io::Result<String> = command.get_value("");
    Ok(registered.ok().as_deref() == Some(windows_command(manifest)?.as_str()))
}

#[cfg(target_os = "windows")]
fn platform_uninstall(manifest: Option<&RegistrationManifest>) -> CaptureResult<()> {
    use winreg::RegKey;
    use winreg::enums::HKEY_CURRENT_USER;

    let current_user = RegKey::predef(HKEY_CURRENT_USER);
    let root = match current_user.open_subkey(WINDOWS_REGISTRY_KEY) {
        Ok(root) => root,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    };
    let owner: io::Result<u32> = root.get_value(WINDOWS_OWNER_VALUE);
    if owner.ok() != Some(u32::from(REGISTRATION_SCHEMA_VERSION)) {
        return Err(CaptureError::Registration(
            "refusing to remove a URL scheme not owned by ResearchPocket".into(),
        ));
    }
    if let Some(manifest) = manifest
        && !platform_is_registered(manifest)?
    {
        return Err(CaptureError::Registration(
            "refusing to remove a modified ResearchPocket URL scheme".into(),
        ));
    }
    drop(root);
    current_user.delete_subkey_all(WINDOWS_REGISTRY_KEY)?;
    windows_notify_association_change();
    Ok(())
}

#[cfg(target_os = "windows")]
fn windows_notify_association_change() {
    use std::ptr;
    use windows_sys::Win32::UI::Shell::{SHCNE_ASSOCCHANGED, SHCNF_IDLIST, SHChangeNotify};

    // SAFETY: SHCNE_ASSOCCHANGED with SHCNF_IDLIST requires both item pointers to be null.
    unsafe {
        SHChangeNotify(
            SHCNE_ASSOCCHANGED as i32,
            SHCNF_IDLIST,
            ptr::null(),
            ptr::null(),
        );
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
fn platform_install(_manifest: &RegistrationManifest) -> CaptureResult<()> {
    Err(CaptureError::Registration(
        "capture handler installation is not supported on this operating system".into(),
    ))
}

#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
fn platform_is_registered(_manifest: &RegistrationManifest) -> CaptureResult<bool> {
    Ok(false)
}

#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
fn platform_uninstall(_manifest: Option<&RegistrationManifest>) -> CaptureResult<()> {
    Ok(())
}

fn notify(success: bool) {
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    let message = if success {
        "Link saved locally"
    } else {
        "Could not save link"
    };

    #[cfg(target_os = "linux")]
    let _ = notification_command("notify-send")
        .args(["--app-name", "ResearchPocket", "ResearchPocket", message])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();

    #[cfg(target_os = "macos")]
    let _ = notification_command("/usr/bin/osascript")
        .args([
            "-e",
            "on run argv",
            "-e",
            "display notification (item 1 of argv) with title \"ResearchPocket\"",
            "-e",
            "end run",
            message,
        ])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();

    #[cfg(target_os = "windows")]
    {
        let script = if success {
            WINDOWS_SUCCESS_NOTIFICATION
        } else {
            WINDOWS_FAILURE_NOTIFICATION
        };
        let _ = notification_command("powershell.exe")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-WindowStyle",
                "Hidden",
                "-Command",
                script,
            ])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }

    #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
    let _ = success;
}

fn notification_command(program: &str) -> Command {
    let mut command = Command::new(program);
    for variable in NOTIFICATION_SECRET_ENV_VARS {
        command.env_remove(variable);
    }
    command
}

#[cfg(target_os = "windows")]
const WINDOWS_SUCCESS_NOTIFICATION: &str = r#"$x=[Windows.Data.Xml.Dom.XmlDocument,Windows.Data.Xml.Dom.XmlDocument,ContentType=WindowsRuntime]::new();$x.LoadXml('<toast><visual><binding template="ToastGeneric"><text>ResearchPocket</text><text>Link saved locally</text></binding></visual></toast>');[Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime]::CreateToastNotifier('ResearchPocket').Show([Windows.UI.Notifications.ToastNotification]::new($x))"#;

#[cfg(target_os = "windows")]
const WINDOWS_FAILURE_NOTIFICATION: &str = r#"$x=[Windows.Data.Xml.Dom.XmlDocument,Windows.Data.Xml.Dom.XmlDocument,ContentType=WindowsRuntime]::new();$x.LoadXml('<toast><visual><binding template="ToastGeneric"><text>ResearchPocket</text><text>Could not save link</text></binding></visual></toast>');[Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime]::CreateToastNotifier('ResearchPocket').Show([Windows.UI.Notifications.ToastNotification]::new($x))"#;

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn versioned_capture_validation_and_v2_mutation_are_one_atomic_boundary() {
        let command = notification_command("unused-notification-helper");
        for variable in NOTIFICATION_SECRET_ENV_VARS {
            assert!(command.get_envs().any(|(name, value)| {
                name == std::ffi::OsStr::new(variable) && value.is_none()
            }));
        }

        let directory = tempfile::tempdir().expect("temporary library");
        let store = V2Store::init(directory.path())
            .await
            .expect("initialize V2");
        drop(store);

        let valid_v1 = "researchpocket://capture?version=1&url=https%3A%2F%2Fexample.com%2Fa%20b%3Fx%3D1%26y%3D%2525&title=Unicode%20%E2%9C%93%20%22quote%22%20%26%20spaces&tag=one%2Ctwo&tag=%20exact%20&note=Keep%20%24%28this%29%20private&favorite=true";
        let item = handle(directory.path(), valid_v1, false, None)
            .await
            .expect("valid version 1 capture");
        assert_eq!(item.url, "https://example.com/a b?x=1&y=%25");
        assert_eq!(item.title.as_deref(), Some("Unicode ✓ \"quote\" & spaces"));
        assert_eq!(item.excerpt, None);
        assert_eq!(item.tags, [" exact ", "one,two"]);
        assert_eq!(item.note.as_deref(), Some("Keep $(this) private"));
        assert!(item.favorite);
        assert_eq!(item.language, None);

        let valid_v2 = "researchpocket://capture?version=2&url=https%3A%2F%2Fexample.com%2Fv2&title=Captured%20page&excerpt=Human-first%20research%20%E2%9C%93&language=en-GB&tag=reading&tag=rust";
        let item = handle(
            directory.path(),
            valid_v2,
            false,
            Some(EnrichmentProvider::Direct),
        )
        .await
        .expect("valid version 2 capture");
        assert_eq!(item.url, "https://example.com/v2");
        assert_eq!(item.title.as_deref(), Some("Captured page"));
        assert_eq!(item.excerpt.as_deref(), Some("Human-first research ✓"));
        assert_eq!(item.language.as_deref(), Some("en-GB"));
        assert_eq!(item.tags, ["reading", "rust"]);

        let store = V2Store::open(directory.path()).await.expect("open V2");
        let saved = store
            .list(Default::default())
            .await
            .expect("list persisted captures");
        let persisted_v2 = saved
            .items
            .iter()
            .find(|saved| saved.id == item.id)
            .expect("persisted version 2 capture");
        assert_eq!(
            persisted_v2.excerpt.as_deref(),
            Some("Human-first research ✓")
        );
        assert_eq!(persisted_v2.language.as_deref(), Some("en-GB"));
        assert_eq!(persisted_v2.tags, ["reading", "rust"]);
        let enrichment = store
            .enrichment_job(&item.id)
            .await
            .expect("read atomic enrichment job")
            .expect("version 2 capture enrichment job");
        assert_eq!(enrichment.provider, EnrichmentProvider::Direct);
        assert_eq!(enrichment.status, research_store::EnrichmentStatus::Skipped);
        assert!(!enrichment.target_title);
        assert!(!enrichment.target_excerpt);
        assert!(!enrichment.target_language);
        let after_valid = store.status().await.expect("status after capture");
        assert_eq!(after_valid.active_items, 2);
        assert_eq!(after_valid.pending_updates, 2);
        drop(store);

        let invalid = vec![
            "research://capture?version=1&url=https%3A%2F%2Fexample.com".to_owned(),
            "researchpocket://capture/?version=1&url=https%3A%2F%2Fexample.com".to_owned(),
            "researchpocket://capture?version=1&url=https%3A%2F%2Fexample.com&url=https%3A%2F%2Fexample.org".to_owned(),
            "researchpocket://capture?version=1&url=https%3A%2F%2Fexample.com&db_path=%2Ftmp%2Flibrary.sqlite3".to_owned(),
            "researchpocket://capture?version=1&url=https%3A%2F%2Fexample.com&excerpt=not%20valid%20in%20v1".to_owned(),
            "researchpocket://capture?version=1&url=https%3A%2F%2Fexample.com&language=en".to_owned(),
            "researchpocket://capture?version=3&url=https%3A%2F%2Fexample.com".to_owned(),
            "researchpocket://capture?version=2&url=https%3A%2F%2Fexample.com&excerpt=one&excerpt=two".to_owned(),
            "researchpocket://capture?version=2&url=https%3A%2F%2Fexample.com&language=en&language=fr".to_owned(),
            "researchpocket://capture?version=1&url=https%3A%2F%2Fuser%3Asecret%40example.com".to_owned(),
            "researchpocket://capture?version=1&url=https%3A%2F%2Fexample.com&title=%1Bterminal".to_owned(),
            "researchpocket://capture?version=1&url=https%3A%2F%2Fexample.com&title=%FF".to_owned(),
            "researchpocket://capture?version=1&url=https%3A%2F%2Fexample.com&title=%ZZ".to_owned(),
            "researchpocket://capture?version=1&url=https%3A%2F%2Fexample.com&title=%1".to_owned(),
            " researchpocket://capture?version=1&url=https%3A%2F%2Fexample.com".to_owned(),
            "researchpocket://capture?version=1&url=https%3A%2F%2Fexample.com\n".to_owned(),
            format!(
                "researchpocket://capture?version=1&url=https%3A%2F%2Fexample.com&title={}",
                "x".repeat(MAX_TITLE_BYTES + 1)
            ),
            format!(
                "researchpocket://capture?version=1&url=https%3A%2F%2Fexample.com{}",
                "&tag=tag".repeat(MAX_TAGS + 1)
            ),
            format!(
                "researchpocket://capture?version=2&url=https%3A%2F%2Fexample.com&excerpt={}",
                "x".repeat(MAX_EXCERPT_BYTES + 1)
            ),
            format!(
                "researchpocket://capture?version=2&url=https%3A%2F%2Fexample.com&language={}",
                "x".repeat(MAX_LANGUAGE_BYTES + 1)
            ),
        ];
        for capture_uri in &invalid {
            assert!(
                handle(directory.path(), capture_uri, false, None)
                    .await
                    .is_err()
            );
        }
        let oversized = format!(
            "researchpocket://capture?version=1&url=https%3A%2F%2Fexample.com&note={}",
            "x".repeat(MAX_CAPTURE_URI_BYTES)
        );
        assert!(
            handle(directory.path(), &oversized, false, None)
                .await
                .is_err()
        );

        let store = V2Store::open(directory.path()).await.expect("open V2");
        let after_invalid = store.status().await.expect("status after rejection");
        assert_eq!(after_invalid.active_items, after_valid.active_items);
        assert_eq!(after_invalid.pending_updates, after_valid.pending_updates);
        assert_eq!(after_invalid.next_sequence, after_valid.next_sequence);
    }
}
