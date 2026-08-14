#[cfg(debug_assertions)]
mod dev_server_reclaim;
mod single_instance;

use anyhow::Context as _;
use harness_server::{ServerConfig, ServerHandle, start};

fn main() -> anyhow::Result<()> {
    let (shell_sender, shell_receiver) = async_channel::unbounded();
    let Some(_single_instance) = single_instance::SingleInstance::acquire(shell_sender.clone())?
    else {
        return Ok(());
    };

    if std::env::var_os("HARNESS_SERVER_URL").is_some() {
        return harness_ui::run_with_shell(shell_sender, shell_receiver);
    }

    let config = ServerConfig::embedded_from_environment()?;
    let server =
        start_embedded_server(config).context("failed to start the embedded TasteCode server")?;
    let endpoint = harness_ui::Endpoint::loopback(server.address().port());
    harness_ui::run_with_endpoint_and_shell(endpoint, shell_sender, shell_receiver)?;
    drop(server);
    Ok(())
}

fn start_embedded_server(config: ServerConfig) -> anyhow::Result<ServerHandle> {
    match start(config.clone()) {
        Ok(server) => Ok(server),
        #[cfg(debug_assertions)]
        Err(harness_server::ServerError::Io(error))
            if error.kind() == std::io::ErrorKind::AddrInUse =>
        {
            dev_server_reclaim::reclaim(config.address)?;
            start(config).map_err(Into::into)
        }
        Err(error) => Err(error.into()),
    }
}
