use crate::ServerState;
use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use harness_protocol::{
    ConnectionAddress, ConnectionAddressKind, ConnectionClaimResult, ConnectionsStatus,
    DeviceConnectionStatus, PairingOffer,
};
use sha2::{Digest as _, Sha256};
use std::collections::{HashMap, HashSet};
use std::ffi::OsStr;
use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpListener};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use thiserror::Error;
use url::Url;
use uuid::Uuid;

const PAIRING_TTL: Duration = Duration::from_secs(5 * 60);
const LISTENER_POLL_INTERVAL: Duration = Duration::from_millis(40);

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum ConnectionAccess {
    Admin,
    Pairing { ticket_hash: String },
    Device { device_id: String },
}

#[derive(Debug, Error)]
pub(crate) enum MobileAccessError {
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Store(#[from] harness_store::StoreError),
    #[error("mobile access mutex poisoned")]
    Poisoned,
    #[error("No Tailscale or private LAN address is available on this computer")]
    NoReachableAddress,
    #[error("A current pairing ticket is required")]
    PairingRequired,
    #[error("This pairing code has expired")]
    PairingExpired,
    #[error("the mobile listener thread panicked")]
    ThreadPanicked,
    #[error("the system clock is before the Unix epoch")]
    InvalidClock,
}

#[derive(Default)]
struct MobileAccessState {
    listening_port: Option<u16>,
    addresses: Vec<ConnectionAddress>,
    tickets: HashMap<String, u64>,
    shutdown: Option<Arc<AtomicBool>>,
    join: Option<JoinHandle<()>>,
    generation: u64,
}

pub(crate) struct MobileAccess {
    configured_port: u16,
    server_name: String,
    address_override: Option<Vec<ConnectionAddress>>,
    lifecycle: Mutex<()>,
    state: Mutex<MobileAccessState>,
}

impl MobileAccess {
    pub(crate) fn new(
        configured_port: u16,
        address_override: Option<Vec<ConnectionAddress>>,
    ) -> Self {
        Self {
            configured_port,
            server_name: server_name(),
            address_override,
            lifecycle: Mutex::new(()),
            state: Mutex::new(MobileAccessState::default()),
        }
    }

    pub(crate) fn start(&self, server: &Arc<ServerState>) -> Result<(), MobileAccessError> {
        let _lifecycle = self
            .lifecycle
            .lock()
            .map_err(|_| MobileAccessError::Poisoned)?;
        self.start_locked(server)
    }

    pub(crate) fn stop(&self) -> Result<(), MobileAccessError> {
        let _lifecycle = self
            .lifecycle
            .lock()
            .map_err(|_| MobileAccessError::Poisoned)?;
        self.stop_locked()
    }

    pub(crate) fn status(
        &self,
        server: &ServerState,
    ) -> Result<ConnectionsStatus, MobileAccessError> {
        let (listening_port, addresses) = {
            let state = self.state.lock().map_err(|_| MobileAccessError::Poisoned)?;
            (state.listening_port, state.addresses.clone())
        };
        let devices = server
            .store
            .lock()
            .map_err(|_| MobileAccessError::Poisoned)?
            .paired_devices()?;
        Ok(ConnectionsStatus {
            enabled: listening_port.is_some(),
            server_name: self.server_name.clone(),
            port: listening_port.unwrap_or(self.configured_port),
            addresses: if listening_port.is_some() {
                addresses
            } else {
                Vec::new()
            },
            devices,
        })
    }

    pub(crate) fn start_pairing(
        &self,
        server: &Arc<ServerState>,
    ) -> Result<PairingOffer, MobileAccessError> {
        let _lifecycle = self
            .lifecycle
            .lock()
            .map_err(|_| MobileAccessError::Poisoned)?;
        self.start_locked(server)?;
        self.refresh_addresses()?;
        let status = self.status(server)?;
        if status.addresses.is_empty() {
            self.stop_locked()?;
            server
                .store
                .lock()
                .map_err(|_| MobileAccessError::Poisoned)?
                .set_mobile_access_enabled(false)?;
            return Err(MobileAccessError::NoReachableAddress);
        }

        let ticket = random_token();
        let expires_at = now_ms()?.saturating_add(PAIRING_TTL.as_millis() as u64);
        let mut state = self.state.lock().map_err(|_| MobileAccessError::Poisoned)?;
        state.tickets.clear();
        state.tickets.insert(digest(&ticket), expires_at);
        drop(state);
        let payload = serde_json::json!({
            "version": 1,
            "serverName": status.server_name,
            "ticket": ticket,
            "expiresAt": expires_at,
            "endpoints": status.addresses.iter().map(|address| &address.url).collect::<Vec<_>>(),
        });
        let payload = URL_SAFE_NO_PAD.encode(payload.to_string());
        Ok(PairingOffer {
            enabled: status.enabled,
            server_name: status.server_name,
            port: status.port,
            addresses: status.addresses,
            devices: status.devices,
            pairing_uri: format!("harness://pair?payload={payload}"),
            expires_at,
        })
    }

    pub(crate) fn authorize(
        &self,
        request_url: &str,
        server: &ServerState,
    ) -> Result<Option<ConnectionAccess>, MobileAccessError> {
        let base = Url::parse("ws://harness.local").expect("static mobile URL must be valid");
        let Ok(url) = base.join(request_url) else {
            return Ok(None);
        };
        self.prune_tickets()?;
        if let Some(ticket) = url
            .query_pairs()
            .find_map(|(key, value)| (key == "pairing_ticket").then(|| value.into_owned()))
        {
            let ticket_hash = digest(&ticket);
            if self
                .state
                .lock()
                .map_err(|_| MobileAccessError::Poisoned)?
                .tickets
                .contains_key(&ticket_hash)
            {
                return Ok(Some(ConnectionAccess::Pairing { ticket_hash }));
            }
        }

        let Some(token) = url
            .query_pairs()
            .find_map(|(key, value)| (key == "token").then(|| value.into_owned()))
        else {
            return Ok(None);
        };
        let store = server
            .store
            .lock()
            .map_err(|_| MobileAccessError::Poisoned)?;
        let Some(device) = store.paired_device_for_token_hash(&digest(&token))? else {
            return Ok(None);
        };
        store.touch_paired_device(&device.id)?;
        Ok(Some(ConnectionAccess::Device {
            device_id: device.id,
        }))
    }

    pub(crate) fn claim(
        &self,
        server: &ServerState,
        access: &ConnectionAccess,
        name: &str,
    ) -> Result<ConnectionClaimResult, MobileAccessError> {
        let ConnectionAccess::Pairing { ticket_hash } = access else {
            return Err(MobileAccessError::PairingRequired);
        };
        let mut state = self.state.lock().map_err(|_| MobileAccessError::Poisoned)?;
        let Some(expires_at) = state.tickets.get(ticket_hash).copied() else {
            return Err(MobileAccessError::PairingExpired);
        };
        if expires_at <= now_ms()? {
            state.tickets.remove(ticket_hash);
            return Err(MobileAccessError::PairingExpired);
        }
        let token = random_token();
        let device = server
            .store
            .lock()
            .map_err(|_| MobileAccessError::Poisoned)?
            .pair_device(&clean_device_name(name), &digest(&token))?;
        state.tickets.remove(ticket_hash);
        Ok(ConnectionClaimResult {
            device_id: device.id,
            device_token: token,
            server_name: self.server_name.clone(),
            addresses: state.addresses.clone(),
        })
    }

    pub(crate) fn revoke(
        &self,
        server: &ServerState,
        device_id: &str,
    ) -> Result<(), MobileAccessError> {
        server
            .store
            .lock()
            .map_err(|_| MobileAccessError::Poisoned)?
            .revoke_paired_device(device_id)?;
        Ok(())
    }

    pub(crate) fn device_status(&self) -> Result<DeviceConnectionStatus, MobileAccessError> {
        let state = self.state.lock().map_err(|_| MobileAccessError::Poisoned)?;
        Ok(DeviceConnectionStatus {
            server_name: self.server_name.clone(),
            addresses: state.addresses.clone(),
        })
    }

    pub(crate) fn is_device_active(&self, server: &ServerState, device_id: &str) -> bool {
        server
            .store
            .lock()
            .ok()
            .and_then(|store| store.has_paired_device(device_id).ok())
            .unwrap_or(false)
    }

    pub(crate) fn listener_address_allowed(&self, local_address: IpAddr) -> bool {
        if local_address.is_loopback() {
            return true;
        }
        let Ok(state) = self.state.lock() else {
            return false;
        };
        state.addresses.iter().any(|address| {
            Url::parse(&address.url)
                .ok()
                .and_then(|url| url.host_str().and_then(|host| host.parse::<IpAddr>().ok()))
                == Some(local_address)
        })
    }

    fn start_locked(&self, server: &Arc<ServerState>) -> Result<(), MobileAccessError> {
        if self
            .state
            .lock()
            .map_err(|_| MobileAccessError::Poisoned)?
            .listening_port
            .is_some()
        {
            return Ok(());
        }
        let listener = TcpListener::bind(SocketAddr::new(
            IpAddr::V4(Ipv4Addr::UNSPECIFIED),
            self.configured_port,
        ))?;
        listener.set_nonblocking(true)?;
        let port = listener.local_addr()?.port();
        let addresses = connection_addresses(port, self.address_override.as_deref());
        let shutdown = Arc::new(AtomicBool::new(false));
        let generation = {
            let mut state = self.state.lock().map_err(|_| MobileAccessError::Poisoned)?;
            state.generation = state.generation.wrapping_add(1);
            state.listening_port = Some(port);
            state.addresses = addresses;
            state.shutdown = Some(Arc::clone(&shutdown));
            state.generation
        };
        let listener_server = Arc::clone(server);
        let listener_shutdown = Arc::clone(&shutdown);
        let join = thread::Builder::new()
            .name("harness-mobile-listener".into())
            .spawn(move || {
                run_mobile_listener(listener, Arc::clone(&listener_server), listener_shutdown);
                listener_server.mobile_access.listener_finished(generation);
            });
        let join = match join {
            Ok(join) => join,
            Err(error) => {
                let mut state = self.state.lock().map_err(|_| MobileAccessError::Poisoned)?;
                if state.generation == generation {
                    state.listening_port = None;
                    state.addresses.clear();
                    state.shutdown = None;
                }
                return Err(error.into());
            }
        };
        self.state
            .lock()
            .map_err(|_| MobileAccessError::Poisoned)?
            .join = Some(join);
        Ok(())
    }

    fn stop_locked(&self) -> Result<(), MobileAccessError> {
        let (shutdown, join) = {
            let mut state = self.state.lock().map_err(|_| MobileAccessError::Poisoned)?;
            state.generation = state.generation.wrapping_add(1);
            state.listening_port = None;
            state.addresses.clear();
            state.tickets.clear();
            (state.shutdown.take(), state.join.take())
        };
        if let Some(shutdown) = shutdown {
            shutdown.store(true, Ordering::Release);
        }
        if let Some(join) = join {
            join.join().map_err(|_| MobileAccessError::ThreadPanicked)?;
        }
        Ok(())
    }

    fn refresh_addresses(&self) -> Result<(), MobileAccessError> {
        let mut state = self.state.lock().map_err(|_| MobileAccessError::Poisoned)?;
        if let Some(port) = state.listening_port {
            state.addresses = connection_addresses(port, self.address_override.as_deref());
        }
        Ok(())
    }

    fn prune_tickets(&self) -> Result<(), MobileAccessError> {
        let now = now_ms()?;
        self.state
            .lock()
            .map_err(|_| MobileAccessError::Poisoned)?
            .tickets
            .retain(|_, expires_at| *expires_at > now);
        Ok(())
    }

    fn listener_finished(&self, generation: u64) {
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        if state.generation == generation {
            state.listening_port = None;
            state.addresses.clear();
            state.shutdown = None;
            state.join = None;
        }
    }
}

fn run_mobile_listener(listener: TcpListener, server: Arc<ServerState>, shutdown: Arc<AtomicBool>) {
    let mut workers = Vec::new();
    while !shutdown.load(Ordering::Acquire) && !server.shutdown.load(Ordering::Acquire) {
        match listener.accept() {
            Ok((stream, _peer)) => {
                let worker_server = Arc::clone(&server);
                let worker_shutdown = Arc::clone(&shutdown);
                match thread::Builder::new()
                    .name("harness-mobile-connection".into())
                    .spawn(move || {
                        crate::handle_mobile_connection(stream, worker_server, worker_shutdown)
                    }) {
                    Ok(worker) => workers.push(worker),
                    Err(error) => eprintln!("[server] failed to start mobile connection: {error}"),
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                thread::sleep(LISTENER_POLL_INTERVAL);
            }
            Err(error) => {
                eprintln!("[server] mobile listener failed: {error}");
                break;
            }
        }
        let mut index = 0;
        while index < workers.len() {
            if workers[index].is_finished() {
                let worker = workers.swap_remove(index);
                let _ = worker.join();
            } else {
                index += 1;
            }
        }
    }
    shutdown.store(true, Ordering::Release);
    for worker in workers {
        let _ = worker.join();
    }
}

fn connection_addresses(
    port: u16,
    address_override: Option<&[ConnectionAddress]>,
) -> Vec<ConnectionAddress> {
    if let Some(addresses) = address_override {
        return addresses
            .iter()
            .filter_map(|address| {
                let mut url = Url::parse(&address.url).ok()?;
                url.set_port(Some(port)).ok()?;
                Some(ConnectionAddress {
                    kind: address.kind,
                    label: address.label.clone(),
                    url: url.to_string().trim_end_matches('/').into(),
                })
            })
            .collect();
    }
    let tailscale_addresses = detect_tailscale_addresses();
    let mut seen = HashSet::new();
    let mut addresses = if_addrs::get_if_addrs()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|interface| {
            let IpAddr::V4(address) = interface.ip() else {
                return None;
            };
            if address.is_loopback() || !seen.insert(address) {
                return None;
            }
            let kind = address_kind(address, &tailscale_addresses)?;
            Some(ConnectionAddress {
                kind,
                label: if kind == ConnectionAddressKind::Tailscale {
                    format!("Tailscale {address}")
                } else {
                    format!("{} {address}", interface.name)
                },
                url: format!("ws://{address}:{port}"),
            })
        })
        .collect::<Vec<_>>();
    addresses.sort_by(|left, right| {
        let left_rank = usize::from(left.kind != ConnectionAddressKind::Tailscale);
        let right_rank = usize::from(right.kind != ConnectionAddressKind::Tailscale);
        left_rank
            .cmp(&right_rank)
            .then_with(|| left.label.cmp(&right.label))
    });
    addresses
}

fn address_kind(
    address: Ipv4Addr,
    tailscale_addresses: &HashSet<Ipv4Addr>,
) -> Option<ConnectionAddressKind> {
    let [first, second, _, _] = address.octets();
    if first == 100 && (64..=127).contains(&second) {
        return tailscale_addresses
            .contains(&address)
            .then_some(ConnectionAddressKind::Tailscale);
    }
    (first == 10
        || (first == 172 && (16..=31).contains(&second))
        || (first == 192 && second == 168))
        .then_some(ConnectionAddressKind::Lan)
}

fn detect_tailscale_addresses() -> HashSet<Ipv4Addr> {
    let mut candidates = vec![PathBuf::from("tailscale")];
    #[cfg(target_os = "macos")]
    candidates.push(PathBuf::from(
        "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
    ));
    #[cfg(target_os = "windows")]
    if let Some(program_files) = std::env::var_os("ProgramFiles") {
        candidates.push(
            PathBuf::from(program_files)
                .join("Tailscale")
                .join("tailscale.exe"),
        );
    }
    let cwd = std::env::current_dir().unwrap_or_else(|_| std::env::temp_dir());
    for candidate in candidates {
        let result = harness_proc::run(
            candidate.as_os_str(),
            &[OsStr::new("ip"), OsStr::new("-4")],
            &cwd,
            Duration::from_secs(3),
            4 * 1_024,
        );
        let Ok(output) = result else {
            continue;
        };
        let addresses = output
            .split_whitespace()
            .filter_map(|value| value.parse::<Ipv4Addr>().ok())
            .collect::<HashSet<_>>();
        if !addresses.is_empty() {
            return addresses;
        }
    }
    HashSet::new()
}

fn digest(value: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(value.as_bytes()))
}

fn random_token() -> String {
    let first = Uuid::new_v4();
    let second = Uuid::new_v4();
    let mut bytes = [0_u8; 32];
    bytes[..16].copy_from_slice(first.as_bytes());
    bytes[16..].copy_from_slice(second.as_bytes());
    URL_SAFE_NO_PAD.encode(bytes)
}

fn clean_device_name(name: &str) -> String {
    let name = name
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(80)
        .collect::<String>();
    if name.is_empty() {
        "Mobile device".into()
    } else {
        name
    }
}

fn server_name() -> String {
    ["COMPUTERNAME", "HOSTNAME"]
        .into_iter()
        .find_map(|key| std::env::var(key).ok())
        .map(|name| name.trim().to_owned())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "Personal Harness".into())
}

fn now_ms() -> Result<u64, MobileAccessError> {
    Ok(SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| MobileAccessError::InvalidClock)?
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn address_classification_rejects_unverified_tailnet_and_public_routes() {
        let tailscale = HashSet::from([Ipv4Addr::new(100, 101, 22, 33)]);
        assert_eq!(
            address_kind(Ipv4Addr::new(100, 101, 22, 33), &tailscale),
            Some(ConnectionAddressKind::Tailscale)
        );
        assert_eq!(address_kind(Ipv4Addr::new(100, 70, 1, 2), &tailscale), None);
        assert_eq!(
            address_kind(Ipv4Addr::new(192, 168, 1, 44), &tailscale),
            Some(ConnectionAddressKind::Lan)
        );
        assert_eq!(address_kind(Ipv4Addr::new(8, 8, 8, 8), &tailscale), None);
    }

    #[test]
    fn pairing_helpers_keep_tokens_private_and_device_names_bounded() {
        let token = random_token();
        assert_eq!(token.len(), 43);
        assert_ne!(digest(&token), token);
        assert_eq!(clean_device_name("  Test   phone  "), "Test phone");
        assert_eq!(clean_device_name("   "), "Mobile device");
        assert_eq!(clean_device_name(&"x".repeat(100)).len(), 80);
    }
}
