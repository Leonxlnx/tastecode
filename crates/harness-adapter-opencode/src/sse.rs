use serde_json::Value;
use std::io::Read;

pub(crate) const MAX_SSE_EVENT: usize = 8 * 1024 * 1024;

#[derive(Debug, PartialEq)]
pub(crate) enum SseFrame {
    Event(Value),
    Unparsable(String),
    Oversized { max_bytes: usize },
}

pub(crate) struct SseDecoder {
    line: Vec<u8>,
    data: Vec<u8>,
    discarding_event: bool,
    max_event_bytes: usize,
}

impl SseDecoder {
    pub(crate) fn new(max_event_bytes: usize) -> Self {
        Self {
            line: Vec::new(),
            data: Vec::new(),
            discarding_event: false,
            max_event_bytes,
        }
    }

    pub(crate) fn push(&mut self, chunk: &[u8]) -> Vec<SseFrame> {
        let mut frames = Vec::new();
        for &byte in chunk {
            if byte == b'\n' {
                self.finish_line(&mut frames);
                continue;
            }
            // `max_event_bytes` applies to the decoded payload. Leave room for
            // the longest meaningful SSE field prefix, `data: `, while still
            // bounding a peer that never sends a newline.
            let max_line_bytes = self.max_event_bytes.saturating_add(6);
            if self.line.len() < max_line_bytes {
                self.line.push(byte);
            } else if !self.discarding_event {
                self.line.clear();
                self.data.clear();
                self.discarding_event = true;
                frames.push(SseFrame::Oversized {
                    max_bytes: self.max_event_bytes,
                });
            }
        }
        frames
    }

    pub(crate) fn finish(&mut self) -> Vec<SseFrame> {
        let mut frames = Vec::new();
        if !self.line.is_empty() {
            self.finish_line(&mut frames);
        }
        if !self.data.is_empty()
            && !self.discarding_event
            && let Some(frame) = decode(&self.data)
        {
            frames.push(frame);
        }
        self.line.clear();
        self.data.clear();
        self.discarding_event = false;
        frames
    }

    fn finish_line(&mut self, frames: &mut Vec<SseFrame>) {
        if self.line.last() == Some(&b'\r') {
            self.line.pop();
        }
        if self.line.is_empty() {
            if !self.discarding_event
                && let Some(frame) = decode(&self.data)
            {
                frames.push(frame);
            }
            self.data.clear();
            self.discarding_event = false;
        } else if !self.discarding_event && self.line.starts_with(b"data:") {
            let mut value = &self.line[5..];
            if value.first() == Some(&b' ') {
                value = &value[1..];
            }
            let separator = usize::from(!self.data.is_empty());
            if self
                .data
                .len()
                .saturating_add(separator)
                .saturating_add(value.len())
                > self.max_event_bytes
            {
                self.data.clear();
                self.discarding_event = true;
                frames.push(SseFrame::Oversized {
                    max_bytes: self.max_event_bytes,
                });
            } else {
                if separator == 1 {
                    self.data.push(b'\n');
                }
                self.data.extend_from_slice(value);
            }
        }
        self.line.clear();
    }
}

pub(crate) fn read_sse(
    mut reader: impl Read,
    max_event_bytes: usize,
    mut on_frame: impl FnMut(SseFrame),
) -> std::io::Result<()> {
    let mut decoder = SseDecoder::new(max_event_bytes);
    let mut chunk = [0_u8; 8192];
    loop {
        match reader.read(&mut chunk)? {
            0 => {
                for frame in decoder.finish() {
                    on_frame(frame);
                }
                return Ok(());
            }
            read => {
                for frame in decoder.push(&chunk[..read]) {
                    on_frame(frame);
                }
            }
        }
    }
}

fn decode(data: &[u8]) -> Option<SseFrame> {
    if data.is_empty() {
        return None;
    }
    let text = String::from_utf8_lossy(data);
    Some(match serde_json::from_str(&text) {
        Ok(value) => SseFrame::Event(value),
        Err(_) => SseFrame::Unparsable(text.into()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn decodes_split_multiline_and_final_unterminated_events() {
        let mut decoder = SseDecoder::new(1024);
        assert!(decoder.push(b": connected\n\ndata: {\"one\":").is_empty());
        assert_eq!(
            decoder.push(b"1}\n\ndata: {\"two\":\ndata: 2}\n\n"),
            [
                SseFrame::Event(json!({ "one": 1 })),
                SseFrame::Event(json!({ "two": 2 })),
            ]
        );
        assert!(decoder.push(b"data: true").is_empty());
        assert_eq!(decoder.finish(), [SseFrame::Event(Value::Bool(true))]);
    }

    #[test]
    fn bounds_one_event_and_recovers_after_its_separator() {
        let mut decoder = SseDecoder::new(8);
        assert_eq!(
            decoder.push(b"data: 123456789\n\ndata: true\n\n"),
            [
                SseFrame::Oversized { max_bytes: 8 },
                SseFrame::Event(Value::Bool(true)),
            ]
        );
    }
}
