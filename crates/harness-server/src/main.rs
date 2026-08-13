use harness_server::{ServerConfig, ServerError, start};

fn main() -> Result<(), ServerError> {
    let server = start(ServerConfig::from_environment()?)?;
    println!("[server] listening on ws://{}", server.address());
    loop {
        std::thread::park();
    }
}
