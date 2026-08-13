use serde_json::{Value, json};
use std::collections::HashMap;
use std::io::{BufRead as _, BufReader, Read as _, Write as _};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::{Duration, Instant};

const WAIT: Duration = Duration::from_secs(3);

#[derive(Clone, Debug)]
pub(crate) struct RequestRecord {
    pub(crate) method: String,
    pub(crate) target: String,
    pub(crate) body: Option<Value>,
    pub(crate) headers: HashMap<String, String>,
}

pub(crate) struct MockOpenCode {
    pub(crate) base_url: String,
    inner: Arc<MockInner>,
    accept: Option<thread::JoinHandle<()>>,
}

struct MockInner {
    requests: Mutex<Vec<RequestRecord>>,
    streams: Mutex<Vec<TcpStream>>,
    changed: Condvar,
    stopping: AtomicBool,
}

impl MockOpenCode {
    pub(crate) fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let address = listener.local_addr().unwrap();
        let inner = Arc::new(MockInner {
            requests: Mutex::new(Vec::new()),
            streams: Mutex::new(Vec::new()),
            changed: Condvar::new(),
            stopping: AtomicBool::new(false),
        });
        let accept_inner = Arc::clone(&inner);
        let accept = thread::spawn(move || {
            while !accept_inner.stopping.load(Ordering::Acquire) {
                match listener.accept() {
                    Ok((stream, _)) => {
                        let inner = Arc::clone(&accept_inner);
                        thread::spawn(move || handle_connection(stream, &inner));
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(5));
                    }
                    Err(_) => return,
                }
            }
        });
        Self {
            base_url: format!("http://{address}"),
            inner,
            accept: Some(accept),
        }
    }

    pub(crate) fn broadcast(&self, event: &Value) {
        let payload = format!("data: {event}\n\n");
        let mut streams = lock(&self.inner.streams);
        streams.retain_mut(|stream| write_chunk(stream, payload.as_bytes()).is_ok());
    }

    pub(crate) fn wait_for_count(&self, path: &str, count: usize) -> Vec<RequestRecord> {
        let deadline = Instant::now() + WAIT;
        let mut requests = lock(&self.inner.requests);
        loop {
            let matches = requests
                .iter()
                .filter(|request| request.target.contains(path))
                .cloned()
                .collect::<Vec<_>>();
            if matches.len() >= count {
                return matches;
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            assert!(!remaining.is_zero(), "request {path} did not arrive");
            let waited = self
                .inner
                .changed
                .wait_timeout(requests, remaining)
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            requests = waited.0;
        }
    }

    pub(crate) fn request_count(&self, path: &str) -> usize {
        lock(&self.inner.requests)
            .iter()
            .filter(|request| request.target.contains(path))
            .count()
    }
}

impl Drop for MockOpenCode {
    fn drop(&mut self) {
        self.inner.stopping.store(true, Ordering::Release);
        for stream in lock(&self.inner.streams).drain(..) {
            let _ = stream.shutdown(Shutdown::Both);
        }
        if let Some(accept) = self.accept.take() {
            let _ = accept.join();
        }
    }
}

fn handle_connection(mut stream: TcpStream, inner: &Arc<MockInner>) {
    let reader_stream = match stream.try_clone() {
        Ok(stream) => stream,
        Err(_) => return,
    };
    let mut reader = BufReader::new(reader_stream);
    let mut request_line = String::new();
    if reader.read_line(&mut request_line).is_err() {
        return;
    }
    let mut request_parts = request_line.split_ascii_whitespace();
    let method = request_parts.next().unwrap_or_default().to_owned();
    let target = request_parts.next().unwrap_or_default().to_owned();
    let mut headers = HashMap::new();
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line).is_err() || line == "\r\n" || line.is_empty() {
            break;
        }
        if let Some((name, value)) = line.split_once(':') {
            headers.insert(name.trim().to_ascii_lowercase(), value.trim().to_owned());
        }
    }
    let content_length = headers
        .get("content-length")
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(0);
    let mut body = vec![0; content_length];
    if reader.read_exact(&mut body).is_err() {
        return;
    }
    let body = (!body.is_empty())
        .then(|| serde_json::from_slice(&body).ok())
        .flatten();
    let path = target.split('?').next().unwrap_or_default();

    if path == "/event" {
        let headers = concat!(
            "HTTP/1.1 200 OK\r\n",
            "Content-Type: text/event-stream\r\n",
            "Transfer-Encoding: chunked\r\n",
            "Cache-Control: no-cache\r\n",
            "Connection: keep-alive\r\n\r\n"
        );
        if stream.write_all(headers.as_bytes()).is_err()
            || write_chunk(
                &mut stream,
                b"data: {\"type\":\"server.connected\",\"properties\":{}}\n\n",
            )
            .is_err()
        {
            return;
        }
        lock(&inner.streams).push(stream);
        return;
    }

    let record = RequestRecord {
        method: method.clone(),
        target: target.clone(),
        body,
        headers,
    };
    lock(&inner.requests).push(record);
    inner.changed.notify_all();

    if method == "GET" && path == "/provider" {
        thread::sleep(Duration::from_millis(100));
        return write_json(
            &mut stream,
            &json!({
                "all": [{
                    "id": "provider-1",
                    "name": "Provider One",
                    "env": [],
                    "models": { "model-1": { "id": "model-1", "name": "Model One" } }
                }],
                "default": { "provider-1": "model-1" },
                "connected": ["provider-1"]
            }),
        );
    }
    if (method == "POST" && path == "/session") || (method == "GET" && path == "/session/session-1")
    {
        return write_json(
            &mut stream,
            &json!({
                "id": "session-1",
                "projectID": "project-1",
                "directory": "C:\\repo",
                "title": "Harness session",
                "version": "1.18.11",
                "time": { "created": 100, "updated": 100 }
            }),
        );
    }
    if path.contains("/prompt_async") || path.contains("/permissions/") || path.ends_with("/abort")
    {
        return write_empty(&mut stream);
    }
    write_status(&mut stream, "404 Not Found", b"not found");
}

fn write_json(stream: &mut TcpStream, value: &Value) {
    write_status(stream, "200 OK", value.to_string().as_bytes());
}

fn write_empty(stream: &mut TcpStream) {
    let _ = stream
        .write_all(b"HTTP/1.1 204 No Content\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
}

fn write_status(stream: &mut TcpStream, status: &str, body: &[u8]) {
    let headers = format!(
        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    let _ = stream.write_all(headers.as_bytes());
    let _ = stream.write_all(body);
}

fn write_chunk(stream: &mut TcpStream, bytes: &[u8]) -> std::io::Result<()> {
    write!(stream, "{:X}\r\n", bytes.len())?;
    stream.write_all(bytes)?;
    stream.write_all(b"\r\n")?;
    stream.flush()
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}
