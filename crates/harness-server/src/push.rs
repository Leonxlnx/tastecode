use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct PendingPush {
    pub(crate) channel: String,
    pub(crate) data: Value,
}

pub(crate) struct PushBus {
    next_connection: AtomicU64,
    connections: Mutex<HashMap<u64, Sender<PendingPush>>>,
}

impl PushBus {
    pub(crate) fn new() -> Self {
        Self {
            next_connection: AtomicU64::new(1),
            connections: Mutex::new(HashMap::new()),
        }
    }

    pub(crate) fn add(&self) -> (u64, Receiver<PendingPush>) {
        let id = self.next_connection.fetch_add(1, Ordering::Relaxed);
        let (sender, receiver) = mpsc::channel();
        self.connections
            .lock()
            .expect("push bus mutex poisoned")
            .insert(id, sender);
        (id, receiver)
    }

    pub(crate) fn remove(&self, connection_id: u64) {
        self.connections
            .lock()
            .expect("push bus mutex poisoned")
            .remove(&connection_id);
    }

    pub(crate) fn send<T: Serialize>(
        &self,
        connection_id: u64,
        channel: &str,
        data: T,
    ) -> Result<(), serde_json::Error> {
        let pending = PendingPush {
            channel: channel.into(),
            data: serde_json::to_value(data)?,
        };
        let mut connections = self.connections.lock().expect("push bus mutex poisoned");
        if connections
            .get(&connection_id)
            .is_some_and(|sender| sender.send(pending).is_err())
        {
            connections.remove(&connection_id);
        }
        Ok(())
    }

    pub(crate) fn broadcast<T: Serialize>(
        &self,
        channel: &str,
        data: T,
    ) -> Result<(), serde_json::Error> {
        let pending = PendingPush {
            channel: channel.into(),
            data: serde_json::to_value(data)?,
        };
        self.connections
            .lock()
            .expect("push bus mutex poisoned")
            .retain(|_, sender| sender.send(pending.clone()).is_ok());
        Ok(())
    }
}
