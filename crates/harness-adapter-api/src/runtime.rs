use crate::{
    ApiAgentSession, ApiSessionOptions, ApiSessionState, ApiTool, ApiToolError, ApiToolExecutor,
    create_transport, list_models,
};
use harness_agent::{
    AgentError, AgentHandlers, AgentResult, AgentRuntime, AgentSession, StartOptions,
};
use harness_protocol::{ApprovalMode, Model, ModelConnectionInput, Thread};
use std::sync::Arc;

pub struct ApiToolSet {
    pub definitions: Vec<ApiTool>,
    pub executor: Arc<dyn ApiToolExecutor>,
}

pub trait ApiToolFactory: Send + Sync {
    fn create(
        &self,
        workspace_path: &str,
        approval: ApprovalMode,
    ) -> Result<ApiToolSet, ApiToolError>;
}

pub struct ApiRuntime {
    connection: ModelConnectionInput,
    api_key: String,
    tools: Arc<dyn ApiToolFactory>,
}

impl ApiRuntime {
    pub fn new(
        connection: ModelConnectionInput,
        api_key: String,
        tools: Arc<dyn ApiToolFactory>,
    ) -> Self {
        Self {
            connection,
            api_key,
            tools,
        }
    }
}

impl AgentRuntime for ApiRuntime {
    fn start(
        &self,
        workspace_path: &str,
        options: &StartOptions,
        handlers: AgentHandlers,
    ) -> AgentResult<(Thread, Arc<dyn AgentSession>)> {
        if !self.connection.enabled {
            return Err(AgentError::Failed(format!(
                "model connection \"{}\" is disabled",
                self.connection.id
            )));
        }
        let model = options
            .model
            .as_deref()
            .or(self.connection.default_model.as_deref())
            .filter(|model| !model.is_empty())
            .ok_or_else(|| {
                AgentError::Failed(format!(
                    "choose a model for \"{}\"",
                    self.connection.display_name
                ))
            })?;
        let transport = create_transport(&self.connection, self.api_key.clone())
            .map_err(|error| AgentError::Failed(error.to_string()))?;
        let approval = options.approval.unwrap_or(ApprovalMode::Ask);
        let tools = self
            .tools
            .create(workspace_path, approval)
            .map_err(|error| AgentError::Failed(error.to_string()))?;
        let mut session_options = ApiSessionOptions::new(model, transport);
        session_options.tools = tools.definitions;
        session_options.executor = tools.executor;
        session_options.secrets = vec![self.api_key.clone()];
        session_options.instructions = options.instructions.clone();
        session_options.approval = approval;
        let (thread, session) = ApiAgentSession::start(
            workspace_path,
            &self.connection.id,
            session_options,
            handlers,
        )?;
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
            .ok_or_else(|| AgentError::Failed("direct API session state is unavailable".into()))?;
        let state = serde_json::from_value::<ApiSessionState>(saved.value().clone())
            .map_err(|_| AgentError::Failed("direct API session state is invalid".into()))?;
        if state.thread.id != thread_id
            || state.thread.workspace_path != workspace_path
            || state.thread.connection_id.as_deref() != Some(self.connection.id.as_str())
        {
            return Err(AgentError::Failed(
                "direct API session state does not match the stored thread".into(),
            ));
        }
        let transport = create_transport(&self.connection, self.api_key.clone())
            .map_err(|error| AgentError::Failed(error.to_string()))?;
        let tools = self
            .tools
            .create(workspace_path, state.approval)
            .map_err(|error| AgentError::Failed(error.to_string()))?;
        let mut session_options = ApiSessionOptions::new(&state.model, transport);
        session_options.tools = tools.definitions;
        session_options.executor = tools.executor;
        session_options.secrets = vec![self.api_key.clone()];
        session_options.instructions = state.instructions.clone();
        session_options.approval = state.approval;
        let (thread, session) = ApiAgentSession::resume(state, session_options, handlers)?;
        Ok((thread, session))
    }

    fn list_models(&self) -> AgentResult<Vec<Model>> {
        list_models(&self.connection, &self.api_key)
            .map_err(|error| AgentError::Failed(error.to_string()))
    }
}
