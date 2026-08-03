# Provider plan

Personal Harness supports two different things that must not be conflated:

- **Agent engines** already own a coding loop, tools and sessions. Harness adapts their
  native protocol, SDK, ACP surface or structured CLI output.
- **Model connections** expose inference APIs but no complete coding agent. The
  Harness-owned API runtime supplies the shared coding loop and tools.

The UI presents both as ways to start a session, while the adapter boundary keeps their
implementation details out of shared contracts and components.

## Integration matrix

| User-facing option     | Integration                                                  | Shared implementation                            |
| ---------------------- | ------------------------------------------------------------ | ------------------------------------------------ |
| Codex subscription     | Codex app-server                                             | Existing native adapter                          |
| Claude subscription    | Claude Code structured CLI                                   | Existing CLI adapter                             |
| ACP agents             | Agent Client Protocol                                        | Existing ACP adapter                             |
| Cursor                 | `cursor-agent --print --output-format stream-json`           | Structured CLI adapter                           |
| OpenCode               | Local server and generated TypeScript SDK                    | Native HTTP/SSE adapter                          |
| Kimi Code              | ACP when available, otherwise captured structured CLI output | ACP or CLI adapter                               |
| GLM / Z.ai coding plan | Supported ACP or CLI surface                                 | ACP or CLI adapter                               |
| OpenAI API             | Responses API                                                | Harness API runtime + native OpenAI transport    |
| Anthropic API          | Messages API                                                 | Harness API runtime + native Anthropic transport |
| OpenRouter             | OpenAI-compatible API                                        | Harness API runtime + compatible transport       |
| Kimi API               | OpenAI-compatible Chat Completions                           | Harness API runtime + compatible transport       |
| GLM / Z.ai API         | OpenAI-compatible Chat Completions                           | Harness API runtime + compatible transport       |
| Custom API             | User-supplied OpenAI-compatible base URL                     | Harness API runtime + compatible transport       |

OpenRouter, Kimi and Z.ai are presets over one compatible transport, not three copied
adapters. Anthropic uses its native Messages API because Anthropic documents its OpenAI
compatibility layer as an evaluation path rather than the production interface.

## Harness API runtime

The API runtime makes the product useful when no vendor agent CLI is installed. Harness
owns the session history, tool loop, approvals, filesystem edits, commands, MCP tools,
skills, queueing, checkpoints, worktrees, review and terminal. A model connection only
streams model output and tool calls.

The first runtime is intentionally small:

1. Send normalized conversation items and tool definitions to the selected transport.
2. Validate every tool call against the same approval and sandbox policy used elsewhere.
3. Execute tools through existing Harness services, then return results to the model.
4. Persist every normalized item before continuing the loop.
5. Stop on completion, interruption, a bounded tool limit or a non-retryable error.

Capabilities remain honest. A direct API session can implement local resume and fork from
Harness history, but it must not claim vendor-hosted history, subscription usage or native
mid-generation steering when those do not exist.

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
2. Harness API runtime with deterministic fake-transport tests.
3. OpenAI Responses transport and a real local end-to-end session.
4. Anthropic Messages transport.
5. OpenAI-compatible transport plus OpenRouter, Kimi, Z.ai and custom presets.
6. OpenCode native adapter against captured HTTP/SSE traffic.
7. Cursor adapter against captured `stream-json` output.
8. Kimi Code and GLM coding-plan discovery through ACP or captured CLI surfaces.

## Definition of done

An option is not supported merely because it appears in a picker. It is done only when it
can start and continue a real session, stream normalized items, interrupt safely, report
capabilities, keep credentials out of logs and storage, and pass captured contract tests on
Windows and macOS. Unsupported actions are hidden or explained; they never fail only after
the user clicks them.
