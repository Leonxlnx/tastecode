use anyhow::{Context as _, Result, anyhow, bail};
use harness_protocol::{
    PreviewCaptureRequest, PreviewCaptureResult, PreviewScreenshot, PreviewViewport,
};
use headless_chrome::browser::default_executable;
use headless_chrome::browser::tab::RequestPausedDecision;
use headless_chrome::protocol::cdp::{Emulation, Fetch, Network, Page, Runtime};
use headless_chrome::{Browser, LaunchOptions};
use std::collections::HashMap;
use std::ffi::OsStr;
use std::fs::{self, OpenOptions};
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime};
use url::Url;
use uuid::Uuid;

const CAPTURE_TIMEOUT: Duration = Duration::from_secs(30);
const STALE_CAPTURE_AGE: Duration = Duration::from_secs(24 * 60 * 60);
const MIN_VIEWPORT_WIDTH: u32 = 320;
const MAX_VIEWPORT_WIDTH: u32 = 3_840;
const MIN_VIEWPORT_HEIGHT: u32 = 240;
const MAX_VIEWPORT_HEIGHT: u32 = 2_160;
const MAX_VIEWPORTS: usize = 4;

const CAPTURE_SETTLE_SCRIPT: &str = r#"new Promise(resolve => requestAnimationFrame(resolve))
  .then(() => Promise.race([
    Promise.allSettled(document.getAnimations().map(animation => animation.finished)),
    new Promise(resolve => setTimeout(resolve, 1000)),
  ]))
  .then(() => document.fonts?.ready)
  .then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))"#;

#[derive(Clone, Debug)]
pub(crate) struct PreviewCaptureRuntime {
    chrome_path: PathBuf,
}

impl PreviewCaptureRuntime {
    pub(crate) fn discover() -> Option<Self> {
        sweep_stale_captures();
        default_executable()
            .ok()
            .filter(|path| path.is_file())
            .map(|chrome_path| Self { chrome_path })
    }

    pub(crate) fn capture(&self, request: PreviewCaptureRequest) -> PreviewCaptureResult {
        let request_id = request.request_id.clone();
        match self.capture_inner(request) {
            Ok(screenshots) => PreviewCaptureResult::Completed {
                request_id,
                screenshots,
            },
            Err(error) => PreviewCaptureResult::Failed {
                request_id,
                error: error.to_string(),
            },
        }
    }

    fn capture_inner(&self, request: PreviewCaptureRequest) -> Result<Vec<PreviewScreenshot>> {
        let preview_url = validate_request(&request)?;
        let capture_directory = CaptureDirectory::create(&request.request_id)?;
        let first_viewport = request
            .viewports
            .first()
            .expect("validated preview capture has a viewport");
        let deadline = Instant::now() + CAPTURE_TIMEOUT;
        let options = LaunchOptions {
            path: Some(self.chrome_path.clone()),
            window_size: Some((first_viewport.width, first_viewport.height)),
            ignore_certificate_errors: false,
            // rust-headless-chrome disables popup blocking by default for browser
            // automation. Keep Chromium's blocker enabled for agent-authored pages.
            ignore_default_args: vec![OsStr::new("--disable-popup-blocking")],
            args: vec![
                OsStr::new("--deny-permission-prompts"),
                OsStr::new("--disable-notifications"),
            ],
            idle_browser_timeout: CAPTURE_TIMEOUT,
            ..LaunchOptions::default()
        };
        let browser = Browser::new(options).context("could not start the preview browser")?;
        let context = browser
            .new_context()
            .context("could not create an isolated preview browser context")?;
        let tab = context
            .new_tab()
            .context("could not create the preview browser tab")?;
        tab.set_default_timeout(remaining(deadline)?);
        enforce_main_frame_origin(&tab, &preview_url)?;

        tab.navigate_to(request.url.as_str())
            .context("could not open the local preview")?;
        tab.set_default_timeout(remaining(deadline)?)
            .wait_until_navigated()
            .context("the local preview did not finish navigating")?;
        ensure_same_origin(&preview_url, &tab.get_url())?;

        let mut captured = HashMap::<(u32, u32), String>::new();
        let mut screenshots = Vec::with_capacity(request.viewports.len());
        for viewport in request.viewports {
            let key = (viewport.width, viewport.height);
            let path = if let Some(path) = captured.get(&key) {
                path.clone()
            } else {
                let path = capture_viewport(
                    &tab,
                    &preview_url,
                    &capture_directory.path,
                    viewport,
                    deadline,
                )?;
                captured.insert(key, path.clone());
                path
            };
            screenshots.push(PreviewScreenshot {
                path,
                width: viewport.width,
                height: viewport.height,
                dom_audit: None,
            });
        }
        capture_directory.preserve();
        Ok(screenshots)
    }
}

fn capture_viewport(
    tab: &headless_chrome::Tab,
    preview_url: &Url,
    directory: &Path,
    viewport: PreviewViewport,
    deadline: Instant,
) -> Result<String> {
    tab.set_default_timeout(remaining(deadline)?);
    tab.call_method(Emulation::SetDeviceMetricsOverride {
        width: viewport.width,
        height: viewport.height,
        device_scale_factor: 1.0,
        mobile: false,
        scale: None,
        screen_width: Some(viewport.width),
        screen_height: Some(viewport.height),
        position_x: None,
        position_y: None,
        dont_set_visible_size: None,
        screen_orientation: None,
        viewport: None,
        display_feature: None,
        device_posture: None,
    })
    .context("could not resize the preview viewport")?;
    settle_preview(tab, deadline)?;
    ensure_same_origin(preview_url, &tab.get_url())?;
    let png = tab
        .capture_screenshot(
            Page::CaptureScreenshotFormatOption::Png,
            None,
            Some(Page::Viewport {
                x: 0.0,
                y: 0.0,
                width: f64::from(viewport.width),
                height: f64::from(viewport.height),
                scale: 1.0,
            }),
            true,
        )
        .context("could not capture the preview viewport")?;
    let actual = png_dimensions(&png)?;
    if actual != (viewport.width, viewport.height) {
        bail!(
            "preview browser returned a {}x{} image for the requested {}x{} viewport",
            actual.0,
            actual.1,
            viewport.width,
            viewport.height
        );
    }
    ensure_same_origin(preview_url, &tab.get_url())?;

    let destination = directory.join(format!("{}x{}.png", viewport.width, viewport.height));
    write_private_file(&destination, &png)?;
    Ok(destination.to_string_lossy().into_owned())
}

fn settle_preview(tab: &headless_chrome::Tab, deadline: Instant) -> Result<()> {
    let timeout = remaining(deadline)?;
    let evaluation = tab
        .call_method(Runtime::Evaluate {
            expression: CAPTURE_SETTLE_SCRIPT.into(),
            object_group: None,
            include_command_line_api: Some(false),
            silent: Some(false),
            context_id: None,
            return_by_value: Some(false),
            generate_preview: Some(false),
            user_gesture: Some(false),
            await_promise: Some(true),
            throw_on_side_effect: None,
            timeout: Some(timeout.as_secs_f64() * 1_000.0),
            disable_breaks: None,
            repl_mode: None,
            allow_unsafe_eval_blocked_by_csp: None,
            unique_context_id: None,
            serialization_options: None,
        })
        .context("the preview did not settle before capture")?;
    if evaluation.exception_details.is_some() {
        bail!("the preview settle script failed");
    }
    Ok(())
}

fn enforce_main_frame_origin(tab: &headless_chrome::Tab, preview_url: &Url) -> Result<()> {
    let main_frame_id = tab
        .call_method(Page::GetFrameTree(None))
        .context("could not inspect the preview frame")?
        .frame_tree
        .frame
        .id;
    let origin = preview_url.origin();
    tab.enable_request_interception(Arc::new(
        move |_transport, _session, event: Fetch::events::RequestPausedEvent| {
            let is_main_frame = event.params.frame_id == main_frame_id;
            let allowed = Url::parse(&event.params.request.url)
                .is_ok_and(|candidate| candidate.origin() == origin);
            if is_main_frame && !allowed {
                RequestPausedDecision::Fail(Fetch::FailRequest {
                    request_id: event.params.request_id,
                    error_reason: Network::ErrorReason::AccessDenied,
                })
            } else {
                RequestPausedDecision::Continue(None)
            }
        },
    ))
    .context("could not secure preview navigation")?;
    tab.enable_fetch(
        Some(&[Fetch::RequestPattern {
            url_pattern: None,
            resource_Type: Some(Network::ResourceType::Document),
            request_stage: Some(Fetch::RequestStage::Request),
        }]),
        Some(false),
    )
    .context("could not enable secure preview navigation")?;
    Ok(())
}

pub(crate) fn validate_request(request: &PreviewCaptureRequest) -> Result<Url> {
    Uuid::parse_str(&request.request_id).context("preview request ID is not a UUID")?;
    let preview_url = Url::parse(&request.url).context("preview URL is invalid")?;
    if preview_url.scheme() != "http"
        || preview_url.host_str() != Some("127.0.0.1")
        || preview_url.port().is_none()
    {
        bail!("preview URL must use HTTP on 127.0.0.1 with an explicit port");
    }
    if request.viewports.is_empty() || request.viewports.len() > MAX_VIEWPORTS {
        bail!("preview capture must request between one and four viewports");
    }
    for viewport in &request.viewports {
        if !(MIN_VIEWPORT_WIDTH..=MAX_VIEWPORT_WIDTH).contains(&viewport.width)
            || !(MIN_VIEWPORT_HEIGHT..=MAX_VIEWPORT_HEIGHT).contains(&viewport.height)
        {
            bail!(
                "preview viewport {}x{} is outside the supported range",
                viewport.width,
                viewport.height
            );
        }
    }
    Ok(preview_url)
}

fn ensure_same_origin(preview_url: &Url, current_url: &str) -> Result<()> {
    let current = Url::parse(current_url).context("preview navigated to an invalid URL")?;
    if current.origin() != preview_url.origin() {
        bail!("preview navigation left the requested origin");
    }
    Ok(())
}

fn remaining(deadline: Instant) -> Result<Duration> {
    deadline
        .checked_duration_since(Instant::now())
        .filter(|remaining| !remaining.is_zero())
        .ok_or_else(|| anyhow!("preview capture timed out"))
}

fn capture_root() -> PathBuf {
    std::env::temp_dir()
        .join("TasteCode")
        .join("preview-captures")
}

struct CaptureDirectory {
    path: PathBuf,
    preserve: bool,
}

impl CaptureDirectory {
    fn create(request_id: &str) -> Result<Self> {
        let root = capture_root();
        fs::create_dir_all(&root).context("could not create the preview capture root")?;
        set_private_directory_permissions(&root)?;
        let path = root.join(request_id);
        fs::create_dir(&path).context("could not create the preview capture directory")?;
        set_private_directory_permissions(&path)?;
        let path = path
            .canonicalize()
            .context("could not resolve the preview capture directory")?;
        Ok(Self {
            path,
            preserve: false,
        })
    }

    fn preserve(mut self) {
        self.preserve = true;
    }
}

impl Drop for CaptureDirectory {
    fn drop(&mut self) {
        if !self.preserve {
            let _ = fs::remove_dir_all(&self.path);
        }
    }
}

fn write_private_file(path: &Path, bytes: &[u8]) -> Result<()> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.mode(0o600);
    }
    let mut file = options
        .open(path)
        .with_context(|| format!("could not create preview screenshot at {}", path.display()))?;
    file.write_all(bytes)
        .with_context(|| format!("could not write preview screenshot at {}", path.display()))
}

fn set_private_directory_permissions(path: &Path) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700)).with_context(|| {
            format!(
                "could not secure preview capture directory at {}",
                path.display()
            )
        })?;
    }
    Ok(())
}

fn sweep_stale_captures() {
    let root = capture_root();
    let Ok(entries) = fs::read_dir(&root) else {
        return;
    };
    let cutoff = SystemTime::now()
        .checked_sub(STALE_CAPTURE_AGE)
        .unwrap_or(SystemTime::UNIX_EPOCH);
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(metadata) = fs::symlink_metadata(&path) else {
            continue;
        };
        let is_stale = metadata.modified().is_ok_and(|modified| modified < cutoff);
        if !is_stale {
            continue;
        }
        if metadata.is_dir() {
            let _ = fs::remove_dir_all(path);
        } else {
            let _ = fs::remove_file(path);
        }
    }
}

fn png_dimensions(bytes: &[u8]) -> Result<(u32, u32)> {
    const PNG_SIGNATURE: &[u8; 8] = b"\x89PNG\r\n\x1a\n";
    if bytes.len() < 24
        || &bytes[..8] != PNG_SIGNATURE
        || &bytes[12..16] != b"IHDR"
        || u32::from_be_bytes(bytes[8..12].try_into().expect("four-byte PNG length")) != 13
    {
        bail!("preview browser returned an invalid PNG image");
    }
    let width = u32::from_be_bytes(bytes[16..20].try_into().expect("four-byte PNG width"));
    let height = u32::from_be_bytes(bytes[20..24].try_into().expect("four-byte PNG height"));
    if width == 0 || height == 0 {
        bail!("preview browser returned an empty PNG image");
    }
    Ok((width, height))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{ErrorKind, Read as _};
    use std::net::TcpListener;
    use std::sync::mpsc;
    use std::thread;

    fn request(url: &str, viewports: Vec<PreviewViewport>) -> PreviewCaptureRequest {
        PreviewCaptureRequest {
            request_id: "019fd8e9-c08d-78a0-b208-c0063be8769d".into(),
            url: url.into(),
            viewports,
        }
    }

    fn desktop() -> PreviewViewport {
        PreviewViewport {
            width: 1_440,
            height: 900,
        }
    }

    #[test]
    fn validates_the_existing_loopback_capture_contract() {
        assert!(validate_request(&request("http://127.0.0.1:5183/", vec![desktop()])).is_ok());
        assert!(validate_request(&request("https://127.0.0.1:5183/", vec![desktop()])).is_err());
        assert!(validate_request(&request("http://localhost:5183/", vec![desktop()])).is_err());
        assert!(validate_request(&request("http://127.0.0.1/", vec![desktop()])).is_err());
    }

    #[test]
    fn rejects_invalid_viewport_shapes() {
        assert!(validate_request(&request("http://127.0.0.1:5183/", Vec::new())).is_err());
        assert!(
            validate_request(&request(
                "http://127.0.0.1:5183/",
                vec![PreviewViewport {
                    width: 319,
                    height: 900,
                }],
            ))
            .is_err()
        );
        assert!(validate_request(&request("http://127.0.0.1:5183/", vec![desktop(); 5])).is_err());
    }

    #[test]
    fn keeps_top_level_navigation_on_the_requested_origin() {
        let base = Url::parse("http://127.0.0.1:5183/").unwrap();
        assert!(ensure_same_origin(&base, "http://127.0.0.1:5183/about").is_ok());
        assert!(ensure_same_origin(&base, "http://127.0.0.1:4311/").is_err());
        assert!(ensure_same_origin(&base, "https://example.com/").is_err());
    }

    #[test]
    fn reads_png_dimensions_without_decoding_pixels() {
        let mut png = vec![0_u8; 24];
        png[..8].copy_from_slice(b"\x89PNG\r\n\x1a\n");
        png[8..12].copy_from_slice(&13_u32.to_be_bytes());
        png[12..16].copy_from_slice(b"IHDR");
        png[16..20].copy_from_slice(&1_440_u32.to_be_bytes());
        png[20..24].copy_from_slice(&900_u32.to_be_bytes());
        assert_eq!(png_dimensions(&png).unwrap(), (1_440, 900));
        png[0] = 0;
        assert!(png_dimensions(&png).is_err());
    }

    #[test]
    #[ignore = "requires an installed Chrome or Chromium binary"]
    fn captures_a_real_loopback_page_at_the_requested_dimensions() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let port = listener.local_addr().unwrap().port();
        let (stop_tx, stop_rx) = mpsc::channel();
        let server = thread::spawn(move || {
            let body = r#"<!doctype html><style>
                html,body { margin:0; width:100%; height:100%; background:#123456 }
                @keyframes settle { from { opacity:.99 } to { opacity:1 } }
                body { animation: settle 20ms linear }
            </style><main>preview</main>"#;
            loop {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        let mut request = [0_u8; 2_048];
                        let _ = stream.read(&mut request);
                        let response = format!(
                            "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                            body.len()
                        );
                        stream.write_all(response.as_bytes()).unwrap();
                    }
                    Err(error) if error.kind() == ErrorKind::WouldBlock => {
                        if stop_rx.try_recv().is_ok() {
                            break;
                        }
                        thread::sleep(Duration::from_millis(5));
                    }
                    Err(error) => panic!("loopback preview server failed: {error}"),
                }
            }
        });

        let runtime = PreviewCaptureRuntime::discover().expect("Chrome or Chromium is installed");
        let request_id = Uuid::new_v4().to_string();
        let result = runtime.capture(PreviewCaptureRequest {
            request_id: request_id.clone(),
            url: format!("http://127.0.0.1:{port}/"),
            viewports: vec![PreviewViewport {
                width: 800,
                height: 600,
            }],
        });
        stop_tx.send(()).unwrap();
        server.join().unwrap();

        let PreviewCaptureResult::Completed { screenshots, .. } = result else {
            panic!("real loopback preview capture failed: {result:?}");
        };
        assert_eq!(screenshots.len(), 1);
        assert_eq!((screenshots[0].width, screenshots[0].height), (800, 600));
        let path = PathBuf::from(&screenshots[0].path);
        assert_eq!(
            png_dimensions(&fs::read(&path).unwrap()).unwrap(),
            (800, 600)
        );
        assert!(path.parent().is_some_and(|parent| {
            parent
                .file_name()
                .is_some_and(|name| name == request_id.as_str())
        }));
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }
}
