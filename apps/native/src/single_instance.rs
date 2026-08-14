use anyhow::{Context as _, Result};
use async_channel::Sender;
use harness_ui::ShellCommand;

pub struct SingleInstance {
    _guard: platform::Guard,
}

impl SingleInstance {
    pub fn acquire(sender: Sender<ShellCommand>) -> Result<Option<Self>> {
        let guard = platform::acquire(sender)?;
        Ok(guard.map(|guard| Self { _guard: guard }))
    }
}

#[cfg(unix)]
mod platform {
    use super::*;
    use anyhow::bail;
    use std::fs::{self, File, OpenOptions, Permissions};
    use std::io;
    use std::os::fd::AsRawFd as _;
    use std::os::unix::fs::{OpenOptionsExt as _, PermissionsExt as _};
    use std::os::unix::net::UnixDatagram;
    use std::path::{Path, PathBuf};
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::thread::{self, JoinHandle};
    use std::time::Duration;

    const LOCK_NAME: &str = "native.lock";
    const ACTIVATE_SOCKET_NAME: &str = "native.activate.sock";
    const ACTIVATE_MESSAGE: &[u8] = b"show";

    pub struct Guard {
        _lock: File,
        socket_path: PathBuf,
        stop: Arc<AtomicBool>,
        listener: Option<JoinHandle<()>>,
    }

    pub fn acquire(sender: Sender<ShellCommand>) -> Result<Option<Guard>> {
        let directory = dirs::data_dir()
            .context("the operating system did not provide an application data directory")?
            .join("PersonalHarness");
        acquire_in_directory(directory, sender)
    }

    fn acquire_in_directory(
        directory: PathBuf,
        sender: Sender<ShellCommand>,
    ) -> Result<Option<Guard>> {
        fs::create_dir_all(&directory).with_context(|| {
            format!(
                "failed to create the TasteCode data directory at {}",
                directory.display()
            )
        })?;
        let lock_path = directory.join(LOCK_NAME);
        let lock = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .open(&lock_path)
            .with_context(|| format!("failed to open {}", lock_path.display()))?;
        fs::set_permissions(&lock_path, Permissions::from_mode(0o600))
            .with_context(|| format!("failed to secure {}", lock_path.display()))?;

        let lock_result = unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
        if lock_result != 0 {
            let error = io::Error::last_os_error();
            if matches!(
                error.raw_os_error(),
                Some(code) if code == libc::EWOULDBLOCK || code == libc::EAGAIN
            ) {
                signal_existing_instance(&directory.join(ACTIVATE_SOCKET_NAME))?;
                return Ok(None);
            }
            return Err(error).with_context(|| format!("failed to lock {}", lock_path.display()));
        }

        let socket_path = directory.join(ACTIVATE_SOCKET_NAME);
        match fs::remove_file(&socket_path) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(error)
                    .with_context(|| format!("failed to remove {}", socket_path.display()));
            }
        }
        let socket = UnixDatagram::bind(&socket_path)
            .with_context(|| format!("failed to bind {}", socket_path.display()))?;
        fs::set_permissions(&socket_path, Permissions::from_mode(0o600))
            .with_context(|| format!("failed to secure {}", socket_path.display()))?;
        socket
            .set_read_timeout(Some(Duration::from_millis(250)))
            .context("failed to configure the TasteCode activation socket")?;

        let stop = Arc::new(AtomicBool::new(false));
        let listener_stop = Arc::clone(&stop);
        let listener = thread::Builder::new()
            .name("harness-native-activation".into())
            .spawn(move || listen_for_activation(socket, sender, listener_stop))
            .context("failed to start the TasteCode activation listener")?;

        Ok(Some(Guard {
            _lock: lock,
            socket_path,
            stop,
            listener: Some(listener),
        }))
    }

    fn listen_for_activation(
        socket: UnixDatagram,
        sender: Sender<ShellCommand>,
        stop: Arc<AtomicBool>,
    ) {
        let mut message = [0_u8; 16];
        while !stop.load(Ordering::Acquire) {
            match socket.recv(&mut message) {
                Ok(length) if &message[..length] == ACTIVATE_MESSAGE => {
                    let _ = sender.try_send(ShellCommand::Show);
                }
                Ok(_) => {}
                Err(error)
                    if matches!(
                        error.kind(),
                        io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
                    ) => {}
                Err(_) => break,
            }
        }
    }

    fn signal_existing_instance(socket_path: &Path) -> Result<()> {
        let socket = UnixDatagram::unbound().context("failed to open an activation socket")?;
        let mut last_error = None;
        for _ in 0..10 {
            match socket.send_to(ACTIVATE_MESSAGE, socket_path) {
                Ok(_) => return Ok(()),
                Err(error)
                    if matches!(
                        error.kind(),
                        io::ErrorKind::NotFound
                            | io::ErrorKind::ConnectionRefused
                            | io::ErrorKind::WouldBlock
                    ) =>
                {
                    last_error = Some(error);
                    thread::sleep(Duration::from_millis(20));
                }
                Err(error) => {
                    return Err(error).with_context(|| {
                        format!(
                            "failed to activate the running TasteCode instance through {}",
                            socket_path.display()
                        )
                    });
                }
            }
        }
        if let Some(error) = last_error {
            return Err(error).with_context(|| {
                format!(
                    "the running TasteCode instance did not accept activation through {}",
                    socket_path.display()
                )
            });
        }
        bail!("the running TasteCode instance could not be activated")
    }

    impl Drop for Guard {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::Release);
            if let Ok(socket) = UnixDatagram::unbound() {
                let _ = socket.send_to(ACTIVATE_MESSAGE, &self.socket_path);
            }
            if let Some(listener) = self.listener.take() {
                let _ = listener.join();
            }
            let _ = fs::remove_file(&self.socket_path);
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn second_instance_activates_primary_and_exits() {
            let directory = tempfile::tempdir().unwrap();
            let (sender, receiver) = async_channel::unbounded();
            let primary = acquire_in_directory(directory.path().to_path_buf(), sender.clone())
                .unwrap()
                .expect("the first instance should own the lock");

            let secondary = acquire_in_directory(directory.path().to_path_buf(), sender).unwrap();

            assert!(secondary.is_none());
            assert_eq!(receiver.recv_blocking().unwrap(), ShellCommand::Show);
            drop(primary);
            assert!(!directory.path().join(ACTIVATE_SOCKET_NAME).exists());
        }

        #[test]
        fn instance_can_restart_after_clean_shutdown() {
            let directory = tempfile::tempdir().unwrap();
            let (sender, _receiver) = async_channel::unbounded();
            let first = acquire_in_directory(directory.path().to_path_buf(), sender.clone())
                .unwrap()
                .unwrap();
            drop(first);

            let restarted = acquire_in_directory(directory.path().to_path_buf(), sender)
                .unwrap()
                .expect("the released lock should be reusable");
            drop(restarted);
        }
    }
}

#[cfg(target_os = "windows")]
mod platform {
    use super::*;
    use std::ptr;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::thread::{self, JoinHandle};
    use windows_sys::Win32::Foundation::{
        CloseHandle, ERROR_ALREADY_EXISTS, GetLastError, HANDLE, WAIT_OBJECT_0,
    };
    use windows_sys::Win32::System::Threading::{
        CreateEventW, CreateMutexW, INFINITE, SetEvent, WaitForSingleObject,
    };

    const EVENT_NAME: &str = "Local\\PersonalHarness.Native.Activate";
    const MUTEX_NAME: &str = "Local\\PersonalHarness.Native.Singleton";

    pub struct Guard {
        event: usize,
        mutex: usize,
        stop: Arc<AtomicBool>,
        listener: Option<JoinHandle<()>>,
    }

    pub fn acquire(sender: Sender<ShellCommand>) -> Result<Option<Guard>> {
        let event_name = wide_name(EVENT_NAME);
        let mutex_name = wide_name(MUTEX_NAME);
        let event = unsafe { CreateEventW(ptr::null(), 0, 0, event_name.as_ptr()) };
        if event.is_null() {
            return Err(std::io::Error::last_os_error())
                .context("failed to create the TasteCode activation event");
        }

        let mutex = unsafe { CreateMutexW(ptr::null(), 0, mutex_name.as_ptr()) };
        let mutex_error = unsafe { GetLastError() };
        if mutex.is_null() {
            unsafe {
                CloseHandle(event);
            }
            return Err(std::io::Error::from_raw_os_error(mutex_error as i32))
                .context("failed to create the TasteCode singleton mutex");
        }
        if mutex_error == ERROR_ALREADY_EXISTS {
            let signaled = unsafe { SetEvent(event) };
            let signal_error = (signaled == 0).then(std::io::Error::last_os_error);
            unsafe {
                CloseHandle(mutex);
                CloseHandle(event);
            }
            if let Some(error) = signal_error {
                return Err(error).context("failed to activate the running TasteCode instance");
            }
            return Ok(None);
        }

        let stop = Arc::new(AtomicBool::new(false));
        let listener_stop = Arc::clone(&stop);
        let event_value = event as usize;
        let listener = match thread::Builder::new()
            .name("harness-native-activation".into())
            .spawn(move || {
                loop {
                    let result = unsafe { WaitForSingleObject(event_value as HANDLE, INFINITE) };
                    if result != WAIT_OBJECT_0 || listener_stop.load(Ordering::Acquire) {
                        break;
                    }
                    let _ = sender.try_send(ShellCommand::Show);
                }
            }) {
            Ok(listener) => listener,
            Err(error) => {
                unsafe {
                    CloseHandle(mutex);
                    CloseHandle(event);
                }
                return Err(error).context("failed to start the TasteCode activation listener");
            }
        };

        Ok(Some(Guard {
            event: event as usize,
            mutex: mutex as usize,
            stop,
            listener: Some(listener),
        }))
    }

    fn wide_name(name: &str) -> Vec<u16> {
        name.encode_utf16().chain(Some(0)).collect()
    }

    impl Drop for Guard {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::Release);
            unsafe {
                SetEvent(self.event as HANDLE);
            }
            if let Some(listener) = self.listener.take() {
                let _ = listener.join();
            }
            unsafe {
                CloseHandle(self.mutex as HANDLE);
                CloseHandle(self.event as HANDLE);
            }
        }
    }
}
