use serde_json::Value;
use std::io::Read;

pub const DEFAULT_MAX_NDJSON_LINE: usize = 8 * 1024 * 1024;

#[derive(Clone, Debug, PartialEq)]
pub enum NdjsonFrame {
    Value(Value),
    Unparsable(String),
    Oversized { max_bytes: usize },
}

pub struct NdjsonDecoder {
    pending: Vec<u8>,
    max_line_bytes: usize,
    discarding_oversized_line: bool,
}

impl Default for NdjsonDecoder {
    fn default() -> Self {
        Self::new(DEFAULT_MAX_NDJSON_LINE)
    }
}

impl NdjsonDecoder {
    pub fn new(max_line_bytes: usize) -> Self {
        Self {
            pending: Vec::new(),
            max_line_bytes,
            discarding_oversized_line: false,
        }
    }

    pub fn push(&mut self, chunk: &[u8]) -> Vec<NdjsonFrame> {
        let mut frames = Vec::new();
        for &byte in chunk {
            if self.discarding_oversized_line {
                if byte == b'\n' {
                    self.discarding_oversized_line = false;
                }
                continue;
            }
            if byte == b'\n' {
                if let Some(frame) = decode_line(&self.pending) {
                    frames.push(frame);
                }
                self.pending.clear();
                continue;
            }
            if self.pending.len() == self.max_line_bytes {
                self.pending.clear();
                self.discarding_oversized_line = true;
                frames.push(NdjsonFrame::Oversized {
                    max_bytes: self.max_line_bytes,
                });
                continue;
            }
            self.pending.push(byte);
        }
        frames
    }

    pub fn finish(&mut self) -> Vec<NdjsonFrame> {
        self.discarding_oversized_line = false;
        let frame = decode_line(&self.pending);
        self.pending.clear();
        frame.into_iter().collect()
    }
}

pub fn read_ndjson(
    mut reader: impl Read,
    max_line_bytes: usize,
    mut on_frame: impl FnMut(NdjsonFrame),
) -> std::io::Result<()> {
    let mut decoder = NdjsonDecoder::new(max_line_bytes);
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

fn decode_line(bytes: &[u8]) -> Option<NdjsonFrame> {
    let line = String::from_utf8_lossy(bytes);
    let line = line.trim();
    if line.is_empty() {
        return None;
    }
    Some(match serde_json::from_str(line) {
        Ok(value) => NdjsonFrame::Value(value),
        Err(_) => NdjsonFrame::Unparsable(line.into()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn retains_split_lines_and_parses_the_final_unterminated_value() {
        let mut decoder = NdjsonDecoder::default();
        assert_eq!(
            decoder.push(b"{\"first\":1}\n{\"seco"),
            [NdjsonFrame::Value(json!({ "first": 1 }))]
        );
        assert!(decoder.push(b"nd\":2}").is_empty());
        assert_eq!(
            decoder.finish(),
            [NdjsonFrame::Value(json!({ "second": 2 }))]
        );
        assert!(decoder.finish().is_empty());
    }

    #[test]
    fn exposes_non_json_lines_and_ignores_whitespace() {
        let mut decoder = NdjsonDecoder::default();
        assert_eq!(
            decoder.push(b" \r\nstartup warning\nnull\n"),
            [
                NdjsonFrame::Unparsable("startup warning".into()),
                NdjsonFrame::Value(Value::Null),
            ]
        );
    }

    #[test]
    fn bounds_one_bad_line_and_recovers_at_the_next_newline() {
        let mut decoder = NdjsonDecoder::new(4);
        assert!(decoder.push(b"1234").is_empty());
        assert_eq!(
            decoder.push(b"5 ignored\ntrue\n"),
            [
                NdjsonFrame::Oversized { max_bytes: 4 },
                NdjsonFrame::Value(Value::Bool(true)),
            ]
        );
        assert!(decoder.finish().is_empty());
    }

    #[test]
    fn blocking_reader_delivers_every_frame_in_order() {
        let mut frames = Vec::new();
        read_ndjson(
            &b"{\"one\":1}\nnot-json\n{\"two\":2}"[..],
            DEFAULT_MAX_NDJSON_LINE,
            |frame| frames.push(frame),
        )
        .unwrap();
        assert_eq!(
            frames,
            [
                NdjsonFrame::Value(json!({ "one": 1 })),
                NdjsonFrame::Unparsable("not-json".into()),
                NdjsonFrame::Value(json!({ "two": 2 })),
            ]
        );
    }
}
