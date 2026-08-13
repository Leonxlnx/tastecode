use harness_client::{ClientEvent, ClientHandle, ConnectionState, Endpoint};
use harness_protocol::{
    AcpAgentsResult, ModelConnectionsResult, ProjectsListResult, ProvidersListResult, Response,
    channel, method,
};
use serde_json::json;
use std::error::Error;
use std::thread;
use std::time::{Duration, Instant};

fn main() -> Result<(), Box<dyn Error>> {
    let (client, events) = ClientHandle::start(Endpoint::from_environment()?)?;
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut projects_request = None;
    let mut providers_request = None;
    let mut connections_request = None;
    let mut agents_request = None;
    let mut project_count = None;
    let mut provider_count = None;
    let mut connection_count = None;
    let mut agent_count = None;
    let mut welcomed = false;

    while Instant::now() < deadline {
        let Ok(event) = events.try_recv() else {
            thread::sleep(Duration::from_millis(10));
            continue;
        };
        match event {
            ClientEvent::StateChanged(ConnectionState::Open) => {
                client.request(
                    method::CLIENT_CAPABILITIES,
                    json!({ "previewCapture": false }),
                )?;
                projects_request = Some(client.request(method::PROJECTS_LIST, json!({}))?);
                providers_request = Some(client.request(method::PROVIDERS_LIST, json!({}))?);
                connections_request = Some(client.request(method::CONNECTIONS_LIST, json!({}))?);
                agents_request = Some(client.request(method::ACP_AGENTS, json!({}))?);
            }
            ClientEvent::Push(push) if push.channel == channel::SERVER_WELCOME => {
                welcomed = true;
            }
            ClientEvent::Response(Response::Success { id, result })
                if projects_request.as_deref() == Some(id.as_str()) =>
            {
                let projects: ProjectsListResult = serde_json::from_value(result)?;
                if !welcomed {
                    return Err("projects.list arrived before server.welcome".into());
                }
                project_count = Some(projects.projects.len());
            }
            ClientEvent::Response(Response::Success { id, result })
                if providers_request.as_deref() == Some(id.as_str()) =>
            {
                provider_count = Some(
                    serde_json::from_value::<ProvidersListResult>(result)?
                        .providers
                        .len(),
                );
            }
            ClientEvent::Response(Response::Success { id, result })
                if connections_request.as_deref() == Some(id.as_str()) =>
            {
                connection_count = Some(
                    serde_json::from_value::<ModelConnectionsResult>(result)?
                        .connections
                        .len(),
                );
            }
            ClientEvent::Response(Response::Success { id, result })
                if agents_request.as_deref() == Some(id.as_str()) =>
            {
                agent_count = Some(
                    serde_json::from_value::<AcpAgentsResult>(result)?
                        .agents
                        .len(),
                );
            }
            ClientEvent::Response(Response::Failure { id, error }) => {
                let requested = [
                    projects_request.as_deref(),
                    providers_request.as_deref(),
                    connections_request.as_deref(),
                    agents_request.as_deref(),
                ]
                .into_iter()
                .flatten()
                .any(|request_id| request_id == id);
                if requested {
                    return Err(format!("protocol probe failed: {}", error.message).into());
                }
            }
            _ => {}
        }
        if let (Some(projects), Some(providers), Some(connections), Some(agents)) =
            (project_count, provider_count, connection_count, agent_count)
        {
            println!(
                "protocol v2 ready; {projects} project(s), {providers} provider(s), {connections} connection(s), {agents} ACP agent(s)"
            );
            return Ok(());
        }
    }

    Err("timed out waiting for projects.list".into())
}
