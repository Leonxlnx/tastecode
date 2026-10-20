# Provider plan

TasteCode supports two different things that must not be conflated:

- **Agent engines** already own a coding loop, tools and sessions. TasteCode adapts their
  native protocol, SDK, ACP surface or structured CLI output.
- **Model connections** expose inference APIs but no complete coding agent. Since
  2026-10-20 OpenCode is the agent for them: a connection only picks the provider, base URL
  and key that an OpenCode session runs on.

The UI presents both as ways to start a session, while the adapter boundary keeps their
implementation details out of shared contracts and components.

Since 2026-10-03 `main` ships only Codex, Claude Code and Grok. Everything else in this plan,
model connections included, lives on the `nightly` branch only.

## Integration matrix

| User-facing option     | Integration                                        | Shared implementation                    |
| ---------------------- | -------------------------------------------------- | ---------------------------------------- |
| Codex subscription     | Codex app-server                                   | Existing native adapter                  |
| Claude subscription    | Claude Code structured CLI                         | Existing CLI adapter                     |
| ACP agents             | Agent Client Protocol                              | Existing ACP adapter                     |
| Cursor                 | `cursor-agent --print --output-format stream-json` | Structured CLI adapter                   |
| OpenCode               | Local server and generated TypeScript SDK          | Native HTTP/SSE adapter                  |
| Kimi Code              | Verified `kimi acp` surface                        | Shared ACP adapter                       |
| GLM / Z.ai coding plan | Provider configured inside OpenCode or Claude Code | Existing OpenCode or Claude Code adapter |
| OpenAI API             | Responses API                                      | OpenCode session, provider `openai`      |
| Anthropic API          | Messages API                                       | OpenCode session, provider `anthropic`   |
| OpenRouter             | OpenAI-compatible API                              | OpenCode session, provider `openrouter`  |
| Kimi API               | OpenAI-compatible Chat Completions                 | OpenCode session, provider `moonshotai`  |
| GLM / Z.ai API         | OpenAI-compatible Chat Completions                 | OpenCode session, provider `zai`         |
| Custom API             | User-supplied OpenAI-compatible base URL           | OpenCode session, provider `tastecode`   |

Each preset uses OpenCode's own provider id, so OpenCode's catalog names the models and
knows their context windows. A custom endpoint becomes a provider named `tastecode` whose
models come from the endpoint's own model list, through the AI SDK package that matches its
transport.

The GLM Coding Plan is not a separate agent or the general Z.ai API preset. It is a
subscription credential and model route used by supported coding agents. TasteCode therefore
runs it through the configured OpenCode or Claude Code agent; the direct Z.ai API option
continues to use the general API endpoint.

## API connections run on OpenCode

Until 2026-10-20 a model connection ran on a small TasteCode-owned loop with four workspace
tools and a 64 KiB request budget, which made a key-backed chat a much weaker agent than any
CLI. It was removed. An API connection now starts an OpenCode session
(`apps/server/src/api-connection-opencode.ts`) that differs from the OpenCode provider in
what it lets in:

- Only the connection's provider is enabled. The key reaches OpenCode as an environment
  variable that the config references; it is never written to the config or a file.
- `OPENCODE_AUTH_CONTENT={}` hides the user's stored OpenCode sign-ins, so a ChatGPT login
  on the `openai` provider cannot run, and bill, the chat instead of the key.
- OpenCode reads its config from TasteCode's own folder (`opencode-api` beside the
  database), so the user's global agents, plugins and default model stay out. Sessions live
  in their own database there, apart from the user's OpenCode history.
- A plugin's `shell.env` hook blanks the key for the agent's shell commands and gives them
  the user's own `XDG_CONFIG_HOME` back. Other processes OpenCode starts, such as language
  servers, still inherit the key.
- Edits and shell commands ask, so the chat's access level decides: Full access approves
  them, Ask shows them.
- The chat's model, or the connection's default, is OpenCode's default model, so a turn
  that names none never falls back to the user's global choice.

OpenCode has to be installed. Without it an API connection's chat fails with a message that
says so. Chats saved by the former loop stay readable but cannot continue.

## Configuration and credentials

- API keys live only in Windows Credential Manager or macOS Keychain.
- The renderer receives connection names and status, never secret values.
- Non-secret base URLs, model defaults and optional headers live in server-owned user
  configuration, not project files or browser storage.
- Custom endpoints require HTTPS unless they bind to `127.0.0.1`.
- Provider-specific request fields are capability-gated transport options, not additions to
  the shared thread model.

## Delivery order

Each line ships as a separate, short-lived PR. Shared contracts land before consumers.

1. Connection contracts and credential references.
2. TasteCode API runtime with deterministic fake-transport tests (removed 2026-10-20).
3. OpenAI Responses transport and a real local end-to-end session (removed 2026-10-20).
4. Anthropic Messages transport (removed 2026-10-20).
5. OpenAI-compatible transport plus OpenRouter, Kimi, Z.ai and custom presets (removed
   2026-10-20).
6. OpenCode native adapter against captured HTTP/SSE traffic; since 2026-10-20 it also runs
   every API connection.
7. Cursor adapter against captured `stream-json` output.
8. Kimi Code through ACP; GLM Coding Plan through configured OpenCode or Claude Code.

## Definition of done

An option is not supported merely because it appears in a picker. It is done only when it
can start and continue a real session, stream normalized items, interrupt safely, report
capabilities, keep credentials out of logs and storage, and pass captured contract tests on
Windows and macOS. Unsupported actions are hidden or explained; they never fail only after
the user clicks them.
