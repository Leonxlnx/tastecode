use base64::{Engine as _, engine::general_purpose::STANDARD};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{Error, ErrorKind, FromSample, Sample, SampleFormat, SizedSample, Stream};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

pub(super) const VOICE_SAMPLE_RATE: u32 = 24_000;
pub(super) const MAX_RECORDING_DURATION: Duration = Duration::from_secs(120);

pub(super) struct VoiceRecording {
    pub(super) audio_base64: String,
    pub(super) duration_ms: u64,
}

pub(super) struct VoiceRecorder {
    stream: Option<Stream>,
    capture: Option<Arc<SharedCapture>>,
    input_rate: u32,
    started_at: Option<Instant>,
}

struct SharedCapture {
    samples: Mutex<Vec<i16>>,
    level_bits: AtomicU32,
    error: Mutex<Option<String>>,
}

impl Default for VoiceRecorder {
    fn default() -> Self {
        Self {
            stream: None,
            capture: None,
            input_rate: VOICE_SAMPLE_RATE,
            started_at: None,
        }
    }
}

impl VoiceRecorder {
    pub(super) fn start(&mut self) -> Result<(), String> {
        if self.stream.is_some() {
            return Err("Voice recording is already running.".into());
        }
        let host = cpal::default_host();
        let device = host
            .default_input_device()
            .ok_or_else(|| "No microphone was found. Connect one and try again.".to_owned())?;
        let supported = device
            .default_input_config()
            .map_err(|error| describe_audio_error(&error))?;
        let input_rate = supported.sample_rate();
        let channels = usize::from(supported.channels()).max(1);
        let maximum_samples = usize::try_from(input_rate)
            .unwrap_or(VOICE_SAMPLE_RATE as usize)
            .saturating_mul(MAX_RECORDING_DURATION.as_secs() as usize);
        let capture = Arc::new(SharedCapture {
            samples: Mutex::new(Vec::with_capacity(
                maximum_samples.min(VOICE_SAMPLE_RATE as usize * 10),
            )),
            level_bits: AtomicU32::new(0.0_f32.to_bits()),
            error: Mutex::new(None),
        });
        let config = supported.config();
        let stream = match supported.sample_format() {
            SampleFormat::I8 => {
                build_stream::<i8>(&device, config, &capture, channels, maximum_samples)
            }
            SampleFormat::I16 => {
                build_stream::<i16>(&device, config, &capture, channels, maximum_samples)
            }
            SampleFormat::I24 => {
                build_stream::<cpal::I24>(&device, config, &capture, channels, maximum_samples)
            }
            SampleFormat::I32 => {
                build_stream::<i32>(&device, config, &capture, channels, maximum_samples)
            }
            SampleFormat::I64 => {
                build_stream::<i64>(&device, config, &capture, channels, maximum_samples)
            }
            SampleFormat::U8 => {
                build_stream::<u8>(&device, config, &capture, channels, maximum_samples)
            }
            SampleFormat::U16 => {
                build_stream::<u16>(&device, config, &capture, channels, maximum_samples)
            }
            SampleFormat::U24 => {
                build_stream::<cpal::U24>(&device, config, &capture, channels, maximum_samples)
            }
            SampleFormat::U32 => {
                build_stream::<u32>(&device, config, &capture, channels, maximum_samples)
            }
            SampleFormat::U64 => {
                build_stream::<u64>(&device, config, &capture, channels, maximum_samples)
            }
            SampleFormat::F32 => {
                build_stream::<f32>(&device, config, &capture, channels, maximum_samples)
            }
            SampleFormat::F64 => {
                build_stream::<f64>(&device, config, &capture, channels, maximum_samples)
            }
            _ => Err("The selected microphone uses an unsupported sample format.".into()),
        }?;
        stream
            .play()
            .map_err(|error| describe_audio_error(&error))?;
        self.stream = Some(stream);
        self.capture = Some(capture);
        self.input_rate = input_rate;
        self.started_at = Some(Instant::now());
        Ok(())
    }

    pub(super) fn elapsed(&self) -> Duration {
        self.started_at.map_or(Duration::ZERO, |started| {
            started.elapsed().min(MAX_RECORDING_DURATION)
        })
    }

    pub(super) fn level(&self) -> f32 {
        self.capture.as_ref().map_or(0.0, |capture| {
            f32::from_bits(capture.level_bits.load(Ordering::Relaxed))
        })
    }

    pub(super) fn take_error(&self) -> Option<String> {
        self.capture
            .as_ref()
            .and_then(|capture| capture.error.lock().ok()?.take())
    }

    pub(super) fn stop(&mut self) -> Result<Option<VoiceRecording>, String> {
        self.stream.take();
        self.started_at = None;
        let Some(capture) = self.capture.take() else {
            return Ok(None);
        };
        if let Some(error) = capture.error.lock().ok().and_then(|mut error| error.take()) {
            return Err(error);
        }
        let samples = std::mem::take(
            &mut *capture
                .samples
                .lock()
                .map_err(|_| "The microphone capture buffer could not be read.".to_owned())?,
        );
        if samples.is_empty() {
            return Ok(None);
        }
        let samples = resample_linear(&samples, self.input_rate, VOICE_SAMPLE_RATE);
        if samples.is_empty() {
            return Ok(None);
        }
        let duration_ms = ((samples.len() as u64 * 1_000) / u64::from(VOICE_SAMPLE_RATE)).max(1);
        let wav = encode_mono_pcm_wav(&samples, VOICE_SAMPLE_RATE);
        Ok(Some(VoiceRecording {
            audio_base64: STANDARD.encode(wav),
            duration_ms,
        }))
    }

    pub(super) fn cancel(&mut self) {
        self.stream.take();
        self.capture.take();
        self.started_at = None;
    }
}

fn build_stream<T>(
    device: &cpal::Device,
    config: cpal::StreamConfig,
    capture: &Arc<SharedCapture>,
    channels: usize,
    maximum_samples: usize,
) -> Result<Stream, String>
where
    T: SizedSample,
    f32: FromSample<T>,
{
    let audio_capture = Arc::clone(capture);
    let error_capture = Arc::clone(capture);
    device
        .build_input_stream::<T, _, _>(
            config,
            move |input, _| {
                audio_capture.push(input, channels, maximum_samples);
            },
            move |error| {
                if let Ok(mut slot) = error_capture.error.try_lock()
                    && slot.is_none()
                    && !matches!(
                        error.kind(),
                        ErrorKind::DeviceChanged | ErrorKind::RealtimeDenied
                    )
                {
                    *slot = Some(describe_audio_error(&error));
                }
            },
            None,
        )
        .map_err(|error| describe_audio_error(&error))
}

impl SharedCapture {
    fn push<T>(&self, input: &[T], channels: usize, maximum_samples: usize)
    where
        T: Sample,
        f32: FromSample<T>,
    {
        let Ok(mut samples) = self.samples.try_lock() else {
            return;
        };
        let remaining = maximum_samples.saturating_sub(samples.len());
        let mut square_sum = 0.0_f32;
        let mut count = 0_usize;
        for frame in input.chunks(channels).take(remaining) {
            let mono = frame
                .iter()
                .map(|sample| f32::from_sample(*sample))
                .sum::<f32>()
                / frame.len().max(1) as f32;
            let mono = mono.clamp(-1.0, 1.0);
            samples.push(pcm16(mono));
            square_sum += mono * mono;
            count += 1;
        }
        if count > 0 {
            let level = ((square_sum / count as f32).sqrt() * 3.2).min(1.0);
            self.level_bits.store(level.to_bits(), Ordering::Relaxed);
        }
    }
}

fn pcm16(sample: f32) -> i16 {
    let scale = if sample < 0.0 { 32_768.0 } else { 32_767.0 };
    (sample.clamp(-1.0, 1.0) * scale).round() as i16
}

fn resample_linear(samples: &[i16], input_rate: u32, output_rate: u32) -> Vec<i16> {
    if samples.is_empty() || input_rate == 0 || output_rate == 0 {
        return Vec::new();
    }
    if input_rate == output_rate {
        return samples.to_vec();
    }
    let ratio = f64::from(input_rate) / f64::from(output_rate);
    let output_len = ((samples.len() as f64) / ratio).round().max(1.0) as usize;
    (0..output_len)
        .map(|index| {
            let source = index as f64 * ratio;
            let left = source.floor() as usize;
            let right = (left + 1).min(samples.len() - 1);
            let mix = source - left as f64;
            let interpolated = f64::from(samples[left])
                + (f64::from(samples[right]) - f64::from(samples[left])) * mix;
            interpolated
                .round()
                .clamp(f64::from(i16::MIN), f64::from(i16::MAX)) as i16
        })
        .collect()
}

fn encode_mono_pcm_wav(samples: &[i16], sample_rate: u32) -> Vec<u8> {
    let data_bytes = u32::try_from(samples.len().saturating_mul(2)).unwrap_or(u32::MAX - 36);
    let mut wav = Vec::with_capacity(44 + data_bytes as usize);
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&(36_u32.saturating_add(data_bytes)).to_le_bytes());
    wav.extend_from_slice(b"WAVEfmt ");
    wav.extend_from_slice(&16_u32.to_le_bytes());
    wav.extend_from_slice(&1_u16.to_le_bytes());
    wav.extend_from_slice(&1_u16.to_le_bytes());
    wav.extend_from_slice(&sample_rate.to_le_bytes());
    wav.extend_from_slice(&sample_rate.saturating_mul(2).to_le_bytes());
    wav.extend_from_slice(&2_u16.to_le_bytes());
    wav.extend_from_slice(&16_u16.to_le_bytes());
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&data_bytes.to_le_bytes());
    for sample in samples {
        wav.extend_from_slice(&sample.to_le_bytes());
    }
    wav
}

fn describe_audio_error(error: &Error) -> String {
    match error.kind() {
        ErrorKind::PermissionDenied => {
            "Microphone access was denied. Allow it in system settings, then try again.".into()
        }
        ErrorKind::DeviceNotAvailable => {
            "No microphone was found. Connect one and try again.".into()
        }
        ErrorKind::DeviceBusy => {
            "The microphone is busy. Close other audio apps and try again.".into()
        }
        ErrorKind::HostUnavailable | ErrorKind::UnsupportedOperation => {
            "Microphone recording is unavailable in this environment.".into()
        }
        _ => error
            .message()
            .map(str::to_owned)
            .unwrap_or_else(|| format!("The microphone could not be opened: {error}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resampling_matches_the_web_recording_length() {
        let samples = vec![0_i16; 48_000];
        assert_eq!(
            resample_linear(&samples, 48_000, VOICE_SAMPLE_RATE).len(),
            24_000
        );
    }

    #[test]
    fn wav_header_matches_the_server_validator() {
        let wav = encode_mono_pcm_wav(&[0, i16::MAX, i16::MIN], VOICE_SAMPLE_RATE);
        assert_eq!(&wav[0..4], b"RIFF");
        assert_eq!(&wav[8..12], b"WAVE");
        assert_eq!(&wav[12..16], b"fmt ");
        assert_eq!(u16::from_le_bytes([wav[22], wav[23]]), 1);
        assert_eq!(
            u32::from_le_bytes([wav[24], wav[25], wav[26], wav[27]]),
            24_000
        );
        assert_eq!(&wav[36..40], b"data");
        assert_eq!(u32::from_le_bytes([wav[40], wav[41], wav[42], wav[43]]), 6);
        assert_eq!(wav.len(), 50);
    }
}
