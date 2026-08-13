use crate::push::PushBus;
use harness_protocol::{
    PreviewCaptureRequest, PreviewCaptureResult, PreviewScreenshot, PreviewViewport, channel,
};
use std::collections::{BTreeSet, HashMap};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};
use thiserror::Error;
use uuid::Uuid;

const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, Error, PartialEq, Eq)]
pub(crate) enum PreviewCaptureError {
    #[error("Preview capture is unavailable")]
    Unavailable,
    #[error("Preview capture timed out")]
    TimedOut,
    #[error("Preview capture client disconnected")]
    Disconnected,
    #[error("Unknown preview capture request")]
    UnknownRequest,
    #[error("Preview capture returned unexpected viewports")]
    UnexpectedViewports,
    #[error("{0}")]
    Failed(String),
    #[error("preview capture mutex poisoned")]
    Poisoned,
    #[error("could not encode preview capture request: {0}")]
    Encode(String),
}

struct CaptureSlot {
    result: Mutex<Option<Result<Vec<PreviewScreenshot>, PreviewCaptureError>>>,
    ready: Condvar,
}

impl CaptureSlot {
    fn new() -> Self {
        Self {
            result: Mutex::new(None),
            ready: Condvar::new(),
        }
    }

    fn complete(&self, result: Result<Vec<PreviewScreenshot>, PreviewCaptureError>) {
        if let Ok(mut current) = self.result.lock()
            && current.is_none()
        {
            *current = Some(result);
            self.ready.notify_all();
        }
    }
}

struct PendingCapture {
    connection_id: u64,
    request: PreviewCaptureRequest,
    slot: Arc<CaptureSlot>,
}

pub(crate) struct PreviewCaptureCoordinator {
    push: Arc<PushBus>,
    clients: Mutex<BTreeSet<u64>>,
    pending: Mutex<HashMap<String, PendingCapture>>,
    timeout: Duration,
}

impl PreviewCaptureCoordinator {
    pub(crate) fn new(push: Arc<PushBus>) -> Self {
        Self::with_timeout(push, DEFAULT_TIMEOUT)
    }

    fn with_timeout(push: Arc<PushBus>, timeout: Duration) -> Self {
        Self {
            push,
            clients: Mutex::new(BTreeSet::new()),
            pending: Mutex::new(HashMap::new()),
            timeout,
        }
    }

    pub(crate) fn available(&self) -> bool {
        self.clients.lock().is_ok_and(|clients| !clients.is_empty())
    }

    pub(crate) fn set_capability(
        &self,
        connection_id: u64,
        available: bool,
    ) -> Result<(), PreviewCaptureError> {
        if available {
            self.clients
                .lock()
                .map_err(|_| PreviewCaptureError::Poisoned)?
                .insert(connection_id);
        } else {
            self.remove(connection_id);
        }
        Ok(())
    }

    pub(crate) fn remove(&self, connection_id: u64) {
        if let Ok(mut clients) = self.clients.lock() {
            clients.remove(&connection_id);
        }
        let disconnected = if let Ok(mut pending) = self.pending.lock() {
            let ids = pending
                .iter()
                .filter(|(_, capture)| capture.connection_id == connection_id)
                .map(|(id, _)| id.clone())
                .collect::<Vec<_>>();
            ids.into_iter()
                .filter_map(|id| pending.remove(&id).map(|capture| capture.slot))
                .collect::<Vec<_>>()
        } else {
            Vec::new()
        };
        for slot in disconnected {
            slot.complete(Err(PreviewCaptureError::Disconnected));
        }
    }

    pub(crate) fn capture(
        &self,
        url: String,
        viewports: Vec<PreviewViewport>,
    ) -> Result<Vec<PreviewScreenshot>, PreviewCaptureError> {
        let connection_id = self
            .clients
            .lock()
            .map_err(|_| PreviewCaptureError::Poisoned)?
            .iter()
            .next()
            .copied()
            .ok_or(PreviewCaptureError::Unavailable)?;
        let request = PreviewCaptureRequest {
            request_id: Uuid::new_v4().to_string(),
            url,
            viewports,
        };
        let slot = Arc::new(CaptureSlot::new());
        self.pending
            .lock()
            .map_err(|_| PreviewCaptureError::Poisoned)?
            .insert(
                request.request_id.clone(),
                PendingCapture {
                    connection_id,
                    request: request.clone(),
                    slot: Arc::clone(&slot),
                },
            );
        if let Err(error) = self.push.send(
            connection_id,
            channel::PREVIEW_CAPTURE_REQUESTED,
            request.clone(),
        ) {
            self.pending
                .lock()
                .map_err(|_| PreviewCaptureError::Poisoned)?
                .remove(&request.request_id);
            return Err(PreviewCaptureError::Encode(error.to_string()));
        }

        let deadline = Instant::now() + self.timeout;
        let mut result = slot
            .result
            .lock()
            .map_err(|_| PreviewCaptureError::Poisoned)?;
        while result.is_none() {
            let now = Instant::now();
            if now >= deadline {
                break;
            }
            let waited = slot
                .ready
                .wait_timeout(result, deadline.saturating_duration_since(now))
                .map_err(|_| PreviewCaptureError::Poisoned)?;
            result = waited.0;
            if waited.1.timed_out() {
                break;
            }
        }
        if let Some(result) = result.take() {
            return result;
        }
        drop(result);
        if let Ok(mut pending) = self.pending.lock() {
            pending.remove(&request.request_id);
        }
        Err(PreviewCaptureError::TimedOut)
    }

    pub(crate) fn complete(
        &self,
        connection_id: u64,
        result: PreviewCaptureResult,
    ) -> Result<(), PreviewCaptureError> {
        let request_id = match &result {
            PreviewCaptureResult::Completed { request_id, .. }
            | PreviewCaptureResult::Failed { request_id, .. } => request_id,
        };
        let capture = {
            let mut pending = self
                .pending
                .lock()
                .map_err(|_| PreviewCaptureError::Poisoned)?;
            if pending
                .get(request_id)
                .is_none_or(|capture| capture.connection_id != connection_id)
            {
                return Err(PreviewCaptureError::UnknownRequest);
            }
            pending
                .remove(request_id)
                .ok_or(PreviewCaptureError::UnknownRequest)?
        };
        let completed = match result {
            PreviewCaptureResult::Failed { error, .. } => Err(PreviewCaptureError::Failed(error)),
            PreviewCaptureResult::Completed { screenshots, .. }
                if screenshots.len() == capture.request.viewports.len()
                    && screenshots.iter().zip(&capture.request.viewports).all(
                        |(screenshot, viewport)| {
                            screenshot.width == viewport.width
                                && screenshot.height == viewport.height
                        },
                    ) =>
            {
                Ok(screenshots)
            }
            PreviewCaptureResult::Completed { .. } => Err(PreviewCaptureError::UnexpectedViewports),
        };
        capture.slot.complete(completed);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unavailable_capture_fails_without_creating_pending_work() {
        let coordinator = PreviewCaptureCoordinator::with_timeout(
            Arc::new(PushBus::new()),
            Duration::from_millis(10),
        );
        assert_eq!(
            coordinator.capture(
                "http://127.0.0.1:5173/".into(),
                vec![PreviewViewport {
                    width: 390,
                    height: 844,
                }],
            ),
            Err(PreviewCaptureError::Unavailable)
        );
    }
}
