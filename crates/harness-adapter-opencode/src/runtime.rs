use crate::http::{OpenCodeHttp, validate_base_url};
use crate::process::{OpenCodeCommand, OpenCodeServer, start_server};
use crate::session::{OpenCodeSession, OpenCodeSessionState};
use harness_agent::{
    AgentError, AgentHandlers, AgentResult, AgentRuntime, AgentSession, ControlHandlers,
    ProviderControl, StartOptions,
};
use harness_protocol::{
    Account, AuthStartLoginResult, McpCapabilities, McpListResult, Model, Thread,
};
use std::ffi::OsString;
use std::sync::{Arc, Condvar, Mutex};
use url::Url;

#[derive(Clone, Debug, Default)]
pub struct OpenCodeLaunchOptions {
    /// Extra process environment for controlled launches and tests.
    pub environment: Vec<(OsString, OsString)>,
    /// Existing literal-loopback server used by integration tests and local development.
    pub base_url: Option<String>,
}

pub struct OpenCodeRuntime {
    pub(crate) inner: Arc<RuntimeInner>,
}

pub(crate) struct RuntimeInner {
    pub(crate) command: OpenCodeCommand,
    configured_base_url: Option<String>,
    model_listing: Mutex<Option<Arc<ModelListing>>>,
}

struct ModelListing {
    result: Mutex<Option<AgentResult<Vec<Model>>>>,
    changed: Condvar,
}

impl ModelListing {
    fn new() -> Self {
        Self {
            result: Mutex::new(None),
            changed: Condvar::new(),
        }
    }
}

pub(crate) enum ServerEndpoint {
    Owned(OpenCodeServer),
    Configured(Url),
}

impl ServerEndpoint {
    pub(crate) fn base_url(&self) -> &Url {
        match self {
            Self::Owned(server) => &server.base_url,
            Self::Configured(url) => url,
        }
    }

    pub(crate) fn close(&self) {
        if let Self::Owned(server) = self {
            server.close();
        }
    }
}

impl OpenCodeRuntime {
    pub fn new(options: OpenCodeLaunchOptions) -> Self {
        Self {
            inner: Arc::new(RuntimeInner {
                command: OpenCodeCommand {
                    program: OsString::from("opencode"),
                    prefix_args: Vec::new(),
                    environment: options.environment,
                    append_provider_args: true,
                },
                configured_base_url: options.base_url,
                model_listing: Mutex::new(None),
            }),
        }
    }
}

impl Default for OpenCodeRuntime {
    fn default() -> Self {
        Self::new(OpenCodeLaunchOptions::default())
    }
}

impl AgentRuntime for OpenCodeRuntime {
    fn start(
        &self,
        workspace_path: &str,
        options: &StartOptions,
        handlers: AgentHandlers,
    ) -> AgentResult<(Thread, Arc<dyn AgentSession>)> {
        let (thread, session) =
            OpenCodeSession::start(Arc::clone(&self.inner), workspace_path, options, handlers)?;
        Ok((thread, session))
    }

    fn resume(
        &self,
        thread_id: &str,
        workspace_path: &str,
        options: &StartOptions,
        handlers: AgentHandlers,
    ) -> AgentResult<(Thread, Arc<dyn AgentSession>)> {
        let saved = options
            .resume_state
            .as_ref()
            .ok_or_else(|| AgentError::Failed("OpenCode session state is unavailable".into()))?;
        let state = serde_json::from_value::<OpenCodeSessionState>(saved.value().clone())
            .map_err(|_| AgentError::Failed("OpenCode session state is invalid".into()))?;
        if state.thread.id != thread_id || state.thread.workspace_path != workspace_path {
            return Err(AgentError::Failed(
                "OpenCode session state does not match the stored thread".into(),
            ));
        }
        let (thread, session) =
            OpenCodeSession::resume(Arc::clone(&self.inner), state, options, handlers)?;
        Ok((thread, session))
    }

    fn list_models(&self) -> AgentResult<Vec<Model>> {
        self.inner.list_models()
    }

    fn open_control(&self, _handlers: ControlHandlers) -> AgentResult<Arc<dyn ProviderControl>> {
        Ok(Arc::new(OpenCodeControl {
            runtime: Arc::clone(&self.inner),
        }))
    }
}

impl RuntimeInner {
    pub(crate) fn endpoint(
        &self,
        options: &StartOptions,
        handlers: &AgentHandlers,
    ) -> AgentResult<ServerEndpoint> {
        if let Some(base_url) = &self.configured_base_url {
            let url = Url::parse(base_url)
                .map_err(|_| AgentError::Failed("OpenCode server URL is invalid".into()))?;
            validate_base_url(&url)?;
            return Ok(ServerEndpoint::Configured(url));
        }
        start_server(
            &self.command,
            &options.mcp_servers,
            &options.mcp_credentials,
            handlers,
        )
        .map(ServerEndpoint::Owned)
    }

    fn list_models(&self) -> AgentResult<Vec<Model>> {
        let (listing, leader) = {
            let mut current = lock(&self.model_listing);
            if let Some(listing) = current.as_ref() {
                (Arc::clone(listing), false)
            } else {
                let listing = Arc::new(ModelListing::new());
                *current = Some(Arc::clone(&listing));
                (listing, true)
            }
        };

        if leader {
            let result = self.list_models_once();
            *lock(&listing.result) = Some(result.clone());
            listing.changed.notify_all();
            let mut current = lock(&self.model_listing);
            if current
                .as_ref()
                .is_some_and(|current| Arc::ptr_eq(current, &listing))
            {
                *current = None;
            }
            return result;
        }

        let mut result = lock(&listing.result);
        while result.is_none() {
            result = listing
                .changed
                .wait(result)
                .unwrap_or_else(|poisoned| poisoned.into_inner());
        }
        result
            .clone()
            .unwrap_or_else(|| Err(AgentError::Failed("OpenCode model discovery failed".into())))
    }

    fn list_models_once(&self) -> AgentResult<Vec<Model>> {
        let handlers = AgentHandlers::default();
        let endpoint = if let Some(base_url) = &self.configured_base_url {
            let url = Url::parse(base_url)
                .map_err(|_| AgentError::Failed("OpenCode server URL is invalid".into()))?;
            validate_base_url(&url)?;
            ServerEndpoint::Configured(url)
        } else {
            start_server(&self.command, &[], &Default::default(), &handlers)
                .map(ServerEndpoint::Owned)?
        };
        let result = OpenCodeHttp::new(endpoint.base_url().clone(), None)?
            .without_directory()
            .list_models();
        endpoint.close();
        result
    }
}

struct OpenCodeControl {
    runtime: Arc<RuntimeInner>,
}

impl ProviderControl for OpenCodeControl {
    fn account(&self) -> AgentResult<Account> {
        Ok(Account {
            signed_in: false,
            email: None,
            plan: None,
        })
    }

    fn start_login(&self) -> AgentResult<AuthStartLoginResult> {
        Err(AgentError::Unsupported("in-app sign-in"))
    }

    fn cancel_login(&self, _login_id: &str) -> AgentResult<()> {
        Err(AgentError::Unsupported("in-app sign-in"))
    }

    fn use_api_key(&self, _api_key: &str) -> AgentResult<Account> {
        Err(AgentError::Unsupported("API key sign-in"))
    }

    fn sign_out(&self) -> AgentResult<()> {
        Err(AgentError::Unsupported("in-app sign-out"))
    }

    fn list_models(&self) -> AgentResult<Vec<Model>> {
        self.runtime.list_models()
    }

    fn list_mcp_servers(&self) -> AgentResult<McpListResult> {
        Ok(McpListResult {
            capabilities: McpCapabilities {
                inventory: false,
                add: true,
                update: true,
                remove: true,
                reload: false,
                start_o_auth: false,
                cancel_o_auth: false,
            },
            servers: Vec::new(),
        })
    }

    fn dispose(&self) {}
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::MockOpenCode;
    use std::ffi::OsStr;
    use std::sync::Barrier;
    use std::thread;

    #[test]
    fn defaults_to_the_opencode_cli_and_exposes_harness_managed_mcp() {
        let runtime = OpenCodeRuntime::default();
        assert_eq!(runtime.inner.command.program, OsStr::new("opencode"));
        let control = runtime.open_control(ControlHandlers::default()).unwrap();
        assert!(!control.account().unwrap().signed_in);
        let mcp = control.list_mcp_servers().unwrap();
        assert!(!mcp.capabilities.inventory);
        assert!(mcp.capabilities.add);
        assert!(mcp.capabilities.update);
        assert!(mcp.capabilities.remove);
    }

    #[test]
    fn shares_one_model_discovery_across_concurrent_callers() {
        let mock = MockOpenCode::start();
        let runtime = Arc::new(OpenCodeRuntime::new(OpenCodeLaunchOptions {
            base_url: Some(mock.base_url.clone()),
            ..OpenCodeLaunchOptions::default()
        }));
        let barrier = Arc::new(Barrier::new(9));
        let callers = (0..8)
            .map(|_| {
                let runtime = Arc::clone(&runtime);
                let barrier = Arc::clone(&barrier);
                thread::spawn(move || {
                    barrier.wait();
                    runtime.list_models()
                })
            })
            .collect::<Vec<_>>();
        barrier.wait();
        for caller in callers {
            let models = caller.join().unwrap().unwrap();
            assert_eq!(models.len(), 1);
            assert_eq!(models[0].id, "provider-1/model-1");
            assert!(models[0].is_default);
        }
        assert_eq!(mock.request_count("/provider"), 1);
    }
}
