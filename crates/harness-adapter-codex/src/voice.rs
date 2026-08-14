use base64::Engine as _;
use base64::engine::general_purpose::{STANDARD, URL_SAFE, URL_SAFE_NO_PAD};
use harness_agent::CancellationToken;
use harness_protocol::{VoiceStatusReason, VoiceStatusResult, VoiceTranscribeParams};
use serde_json::Value;
use std::time::Duration;
use thiserror::Error;
use uuid::Uuid;

pub const VOICE_SAMPLE_RATE: u32 = 24_000;
pub const MAX_VOICE_DURATION_MS: u64 = 120_000;
pub const MAX_VOICE_BYTES: usize = 10 * 1024 * 1024;

const PCM_BYTES_PER_SAMPLE: usize = 2;
const TRANSCRIPTION_URL: &str = "https://chatgpt.com/backend-api/transcribe";
const TRANSCRIPTION_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_RESPONSE_BYTES: usize = 1024 * 1024;

#[derive(Clone)]
pub(crate) struct AuthStatus {
    pub(crate) method: Option<String>,
    pub(crate) token: Option<String>,
}

pub(crate) struct VoiceHttpResponse {
    status: u16,
    body: String,
}

#[derive(Debug, Error)]
pub(crate) enum VoiceError {
    #[error("{0}")]
    InvalidAudio(String),
    #[error("{0}")]
    UnsupportedAuth(String),
    #[error("Voice transcription was cancelled.")]
    Cancelled,
    #[error("{0}")]
    Upstream(String),
}

pub(crate) fn capability<E>(
    auth_status: impl FnOnce(bool, bool) -> Result<AuthStatus, E>,
) -> VoiceStatusResult {
    let Ok(status) = auth_status(false, false) else {
        return unavailable(VoiceStatusReason::CodexTooOld);
    };
    match status.method.as_deref() {
        None => unavailable(VoiceStatusReason::SignInRequired),
        Some(method) if is_chatgpt_auth(method) => VoiceStatusResult {
            available: true,
            reason: None,
        },
        Some(_) => unavailable(VoiceStatusReason::UnsupportedAuth),
    }
}

pub(crate) fn transcribe<E: std::fmt::Display>(
    input: &VoiceTranscribeParams,
    cancellation: &CancellationToken,
    auth_status: impl Fn(bool, bool) -> Result<AuthStatus, E>,
) -> Result<String, VoiceError> {
    transcribe_with(
        input,
        cancellation,
        auth_status,
        request_chatgpt_transcription,
    )
}

fn transcribe_with<E: std::fmt::Display>(
    input: &VoiceTranscribeParams,
    cancellation: &CancellationToken,
    auth_status: impl Fn(bool, bool) -> Result<AuthStatus, E>,
    request: impl Fn(&[u8], &str, &CancellationToken) -> Result<VoiceHttpResponse, VoiceError>,
) -> Result<String, VoiceError> {
    let wav = validate_clip(input)?;
    ensure_not_cancelled(cancellation)?;
    let mut token = resolve_token(false, &auth_status)?;
    let mut response = request(&wav, &token, cancellation)?;
    if matches!(response.status, 401 | 403) {
        ensure_not_cancelled(cancellation)?;
        token = resolve_token(true, &auth_status)?;
        response = request(&wav, &token, cancellation)?;
    }
    ensure_not_cancelled(cancellation)?;
    if !(200..300).contains(&response.status) {
        return Err(response_error(&response));
    }
    read_transcript(&response.body)?
        .filter(|text| !text.is_empty())
        .ok_or_else(|| VoiceError::Upstream("No speech was detected.".into()))
}

fn resolve_token<E: std::fmt::Display>(
    refresh: bool,
    auth_status: &impl Fn(bool, bool) -> Result<AuthStatus, E>,
) -> Result<String, VoiceError> {
    let status =
        auth_status(true, refresh).map_err(|error| VoiceError::Upstream(error.to_string()))?;
    if !status.method.as_deref().is_some_and(is_chatgpt_auth) {
        return Err(VoiceError::UnsupportedAuth(
            "Voice transcription requires a ChatGPT-authenticated Codex session.".into(),
        ));
    }
    if let Some(token) = status.token.filter(|token| !token.is_empty()) {
        return Ok(token);
    }
    if !refresh {
        return resolve_token(true, auth_status);
    }
    Err(VoiceError::UnsupportedAuth(
        "No ChatGPT session token is available. Sign in to ChatGPT in Codex.".into(),
    ))
}

pub(crate) fn validate_clip(input: &VoiceTranscribeParams) -> Result<Vec<u8>, VoiceError> {
    if input.sample_rate_hz != VOICE_SAMPLE_RATE {
        return invalid("Voice audio must be mono 24 kHz WAV.");
    }
    if !(1..=MAX_VOICE_DURATION_MS).contains(&input.duration_ms) {
        return invalid("Voice recordings are limited to 120 seconds.");
    }
    let max_encoded = MAX_VOICE_BYTES.div_ceil(3) * 4;
    if input.audio_base64.len() > max_encoded || !is_strict_base64(&input.audio_base64) {
        return invalid("Voice audio is not valid base64.");
    }
    let wav = STANDARD
        .decode(&input.audio_base64)
        .map_err(|_| VoiceError::InvalidAudio("Voice audio is not valid base64.".into()))?;
    if wav.is_empty() || wav.len() > MAX_VOICE_BYTES {
        return invalid("Voice recordings are limited to 10 MB.");
    }
    if wav.len() < 44
        || &wav[0..4] != b"RIFF"
        || read_u32(&wav, 4) != Some((wav.len() - 8) as u32)
        || &wav[8..12] != b"WAVE"
        || &wav[12..16] != b"fmt "
        || read_u32(&wav, 16) != Some(16)
        || read_u16(&wav, 20) != Some(1)
        || read_u16(&wav, 22) != Some(1)
        || read_u32(&wav, 24) != Some(VOICE_SAMPLE_RATE)
        || read_u32(&wav, 28) != Some(VOICE_SAMPLE_RATE * PCM_BYTES_PER_SAMPLE as u32)
        || read_u16(&wav, 32) != Some(PCM_BYTES_PER_SAMPLE as u16)
        || read_u16(&wav, 34) != Some(16)
        || &wav[36..40] != b"data"
    {
        return invalid("Voice audio must be mono 24 kHz PCM WAV.");
    }
    let declared = read_u32(&wav, 40).unwrap_or_default() as usize;
    if declared == 0 || declared != wav.len() - 44 || !declared.is_multiple_of(2) {
        return invalid("Voice audio has an invalid WAV header.");
    }
    let samples = declared / PCM_BYTES_PER_SAMPLE;
    let expected_ms =
        ((samples as u64 * 1_000) + (VOICE_SAMPLE_RATE as u64 / 2)) / VOICE_SAMPLE_RATE as u64;
    if expected_ms.abs_diff(input.duration_ms) > 250 {
        return invalid("Voice duration does not match the WAV data.");
    }
    Ok(wav)
}

fn request_chatgpt_transcription(
    audio: &[u8],
    token: &str,
    cancellation: &CancellationToken,
) -> Result<VoiceHttpResponse, VoiceError> {
    let boundary = format!("TasteCode-{}", Uuid::new_v4());
    let mut body = Vec::with_capacity(audio.len() + 256);
    body.extend_from_slice(
        format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"voice.wav\"\r\nContent-Type: audio/wav\r\n\r\n"
        )
        .as_bytes(),
    );
    body.extend_from_slice(audio);
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    let cancellation = cancellation.clone();
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|error| VoiceError::Upstream(error.to_string()))?
        .block_on(async move {
            let client = reqwest::Client::builder()
                .timeout(TRANSCRIPTION_TIMEOUT)
                .build()
                .map_err(|error| VoiceError::Upstream(error.to_string()))?;
            let mut request = client
                .post(TRANSCRIPTION_URL)
                .bearer_auth(token)
                .header(
                    reqwest::header::CONTENT_TYPE,
                    format!("multipart/form-data; boundary={boundary}"),
                )
                .header(reqwest::header::ACCEPT_ENCODING, "identity")
                .header(reqwest::header::USER_AGENT, "TasteCode");
            if let Some(account_id) = chatgpt_account_id(token) {
                request = request.header("ChatGPT-Account-ID", account_id);
            }
            let response = tokio::select! {
                biased;
                () = wait_cancelled(&cancellation) => return Err(VoiceError::Cancelled),
                response = request.body(body).send() => response
                    .map_err(|error| VoiceError::Upstream(error.to_string()))?,
            };
            let status = response.status().as_u16();
            if response
                .content_length()
                .is_some_and(|length| length > MAX_RESPONSE_BYTES as u64)
            {
                return Err(VoiceError::Upstream(
                    "Transcription response was too large.".into(),
                ));
            }
            let mut response = response;
            let mut bytes = Vec::new();
            loop {
                let chunk = tokio::select! {
                    biased;
                    () = wait_cancelled(&cancellation) => return Err(VoiceError::Cancelled),
                    chunk = response.chunk() => chunk
                        .map_err(|error| VoiceError::Upstream(error.to_string()))?,
                };
                let Some(chunk) = chunk else {
                    break;
                };
                if bytes.len().saturating_add(chunk.len()) > MAX_RESPONSE_BYTES {
                    return Err(VoiceError::Upstream(
                        "Transcription response was too large.".into(),
                    ));
                }
                bytes.extend_from_slice(&chunk);
            }
            Ok(VoiceHttpResponse {
                status,
                body: String::from_utf8_lossy(&bytes).into_owned(),
            })
        })
}

async fn wait_cancelled(cancellation: &CancellationToken) {
    while !cancellation.is_cancelled() {
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

fn chatgpt_account_id(token: &str) -> Option<String> {
    let payload = token.split('.').nth(1)?;
    let decoded = URL_SAFE_NO_PAD
        .decode(payload)
        .or_else(|_| URL_SAFE.decode(payload))
        .ok()?;
    let payload: Value = serde_json::from_slice(&decoded).ok()?;
    let account_id = payload
        .get("https://api.openai.com/auth")?
        .get("chatgpt_account_id")?
        .as_str()?;
    (!account_id.is_empty()
        && !account_id
            .chars()
            .any(|character| matches!(character, '\r' | '\n')))
    .then(|| account_id.into())
}

fn read_transcript(body: &str) -> Result<Option<String>, VoiceError> {
    let payload: Value = serde_json::from_str(body).map_err(|_| {
        VoiceError::Upstream("The transcription response was not valid JSON.".into())
    })?;
    Ok(payload
        .get("text")
        .and_then(Value::as_str)
        .or_else(|| payload.get("transcript").and_then(Value::as_str))
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_owned))
}

fn response_error(response: &VoiceHttpResponse) -> VoiceError {
    let message = serde_json::from_str::<Value>(&response.body)
        .ok()
        .and_then(|payload| {
            payload
                .pointer("/error/message")
                .and_then(Value::as_str)
                .or_else(|| payload.get("message").and_then(Value::as_str))
                .map(str::trim)
                .filter(|message| !message.is_empty())
                .map(str::to_owned)
        })
        .unwrap_or_else(|| format!("Transcription failed with status {}.", response.status));
    if matches!(response.status, 401 | 403) {
        VoiceError::UnsupportedAuth(message)
    } else {
        VoiceError::Upstream(message)
    }
}

fn ensure_not_cancelled(cancellation: &CancellationToken) -> Result<(), VoiceError> {
    if cancellation.is_cancelled() {
        Err(VoiceError::Cancelled)
    } else {
        Ok(())
    }
}

fn is_chatgpt_auth(method: &str) -> bool {
    matches!(method, "chatgpt" | "chatgptAuthTokens")
}

fn unavailable(reason: VoiceStatusReason) -> VoiceStatusResult {
    VoiceStatusResult {
        available: false,
        reason: Some(reason),
    }
}

fn invalid<T>(message: &str) -> Result<T, VoiceError> {
    Err(VoiceError::InvalidAudio(message.into()))
}

fn is_strict_base64(value: &str) -> bool {
    if !value.len().is_multiple_of(4) {
        return false;
    }
    let bytes = value.as_bytes();
    let padding = bytes.iter().rev().take_while(|byte| **byte == b'=').count();
    padding <= 2
        && bytes[..bytes.len().saturating_sub(padding)]
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(*byte, b'+' | b'/'))
        && bytes[bytes.len().saturating_sub(padding)..]
            .iter()
            .all(|byte| *byte == b'=')
}

fn read_u16(bytes: &[u8], offset: usize) -> Option<u16> {
    Some(u16::from_le_bytes(
        bytes.get(offset..offset + 2)?.try_into().ok()?,
    ))
}

fn read_u32(bytes: &[u8], offset: usize) -> Option<u32> {
    Some(u32::from_le_bytes(
        bytes.get(offset..offset + 4)?.try_into().ok()?,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use harness_protocol::{ProviderId, VoiceMimeType};
    use std::sync::Mutex;

    fn voice_input(duration_ms: u64) -> VoiceTranscribeParams {
        let samples = duration_ms * VOICE_SAMPLE_RATE as u64 / 1_000;
        let mut wav = vec![0_u8; 44 + samples as usize * PCM_BYTES_PER_SAMPLE];
        wav[0..4].copy_from_slice(b"RIFF");
        let riff_size = (wav.len() - 8) as u32;
        wav[4..8].copy_from_slice(&riff_size.to_le_bytes());
        wav[8..12].copy_from_slice(b"WAVE");
        wav[12..16].copy_from_slice(b"fmt ");
        wav[16..20].copy_from_slice(&16_u32.to_le_bytes());
        wav[20..22].copy_from_slice(&1_u16.to_le_bytes());
        wav[22..24].copy_from_slice(&1_u16.to_le_bytes());
        wav[24..28].copy_from_slice(&VOICE_SAMPLE_RATE.to_le_bytes());
        wav[28..32].copy_from_slice(&(VOICE_SAMPLE_RATE * 2).to_le_bytes());
        wav[32..34].copy_from_slice(&2_u16.to_le_bytes());
        wav[34..36].copy_from_slice(&16_u16.to_le_bytes());
        wav[36..40].copy_from_slice(b"data");
        let data_size = (wav.len() - 44) as u32;
        wav[40..44].copy_from_slice(&data_size.to_le_bytes());
        VoiceTranscribeParams {
            request_id: "voice-1".into(),
            provider: ProviderId::Codex,
            audio_base64: STANDARD.encode(wav),
            mime_type: VoiceMimeType::Wav,
            sample_rate_hz: VOICE_SAMPLE_RATE,
            duration_ms,
        }
    }

    #[test]
    fn validates_matching_pcm_and_rejects_forged_duration() {
        let input = voice_input(1_000);
        assert_eq!(validate_clip(&input).unwrap().len(), 48_044);
        let error = validate_clip(&VoiceTranscribeParams {
            duration_ms: 2_000,
            ..input
        })
        .unwrap_err();
        assert!(error.to_string().contains("duration does not match"));
    }

    #[test]
    fn capability_distinguishes_missing_old_and_non_chatgpt_auth() {
        assert_eq!(
            capability::<()>(|_, _| Err(())).reason,
            Some(VoiceStatusReason::CodexTooOld)
        );
        assert_eq!(
            capability::<()>(|_, _| Ok(AuthStatus {
                method: None,
                token: None,
            }))
            .reason,
            Some(VoiceStatusReason::SignInRequired)
        );
        assert_eq!(
            capability::<()>(|_, _| Ok(AuthStatus {
                method: Some("apiKey".into()),
                token: None,
            }))
            .reason,
            Some(VoiceStatusReason::UnsupportedAuth)
        );
    }

    #[test]
    fn refreshes_one_expired_session_and_reads_the_trimmed_transcript() {
        let refreshes = Mutex::new(Vec::new());
        let tokens = Mutex::new(Vec::new());
        let result = transcribe_with(
            &voice_input(1_000),
            &CancellationToken::default(),
            |_, refresh| {
                refreshes.lock().unwrap().push(refresh);
                Ok::<_, &'static str>(AuthStatus {
                    method: Some("chatgpt".into()),
                    token: Some(if refresh { "fresh" } else { "stale" }.into()),
                })
            },
            |_, token, _| {
                tokens.lock().unwrap().push(token.to_owned());
                Ok(if token == "stale" {
                    VoiceHttpResponse {
                        status: 401,
                        body: "{}".into(),
                    }
                } else {
                    VoiceHttpResponse {
                        status: 200,
                        body: r#"{"transcript":"  hello from voice  "}"#.into(),
                    }
                })
            },
        )
        .unwrap();
        assert_eq!(result, "hello from voice");
        assert_eq!(*refreshes.lock().unwrap(), [false, true]);
        assert_eq!(*tokens.lock().unwrap(), ["stale", "fresh"]);
    }

    #[test]
    fn reads_chatgpt_account_routing_claim_without_accepting_headers() {
        let payload = URL_SAFE_NO_PAD.encode(
            serde_json::json!({
                "https://api.openai.com/auth": { "chatgpt_account_id": "workspace-123" }
            })
            .to_string(),
        );
        assert_eq!(
            chatgpt_account_id(&format!("header.{payload}.signature")).as_deref(),
            Some("workspace-123")
        );
        assert_eq!(chatgpt_account_id("not-a-jwt"), None);
    }
}
