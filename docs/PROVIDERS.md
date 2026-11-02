# Provider plan

TasteCode supports two different things that must not be conflated:

- **Agent engines** already own a coding loop, tools and sessions. TasteCode adapts their
  native protocol, SDK, ACP surface or structured CLI output.
- **Model connections** expose inference APIs but no complete coding agent. TasteCode
  removed them on 2026-10-20: a user's own API key goes into an agent engine that supports
  keys, today OpenCode's sign-in, and runs as that engine's session.

The UI presents both as ways to start a session, while the adapter boundary keeps their
implementation details out of shared contracts and components.

Since 2026-10-03 `main` ships only Codex, Claude Code and Grok. Everything else in this plan
lives on the `nightly` branch only.

## Integration matrix

| User-facing option     | Integration                                        | Shared implementation                    |
| ---------------------- | -------------------------------------------------- | ---------------------------------------- |
| Codex subscription     | Codex app-server                                   | Existing native adapter                  |
| Claude subscription    | Claude Code structured CLI                         | Existing CLI adapter                     |
| ACP agents             | Agent Client Protocol                              | Existing ACP adapter                     |
| Cursor                 | `cursor-agent --print --output-format stream-json` | Structured CLI adapter                   |
| OpenCode               | Local server and generated TypeScript SDK          | Native HTTP/SSE adapter                  |
| Own API key            | Signed in inside OpenCode                          | Existing OpenCode adapter                |
| Kimi Code              | Verified `kimi acp` surface                        | Shared ACP adapter                       |
| GLM / Z.ai coding plan | Provider configured inside OpenCode or Claude Code | Existing OpenCode or Claude Code adapter |

The GLM Coding Plan is not a separate agent or the general Z.ai API preset. It is a
subscription credential and model route used by supported coding agents. TasteCode therefore
runs it through the configured OpenCode or Claude Code agent.

## API connections were removed

Until 2026-10-20 a model connection ran on a small TasteCode-owned loop with four workspace
tools and a 64 KiB request budget, which made a key-backed chat a much weaker agent than any
CLI. An OpenCode-backed replacement was built the same day and removed with the feature. A
user signs in to OpenCode with their key and chats through the OpenCode provider. Chats saved
under an API connection stay readable but cannot start again.

## Delivery order

Each line ships as a separate, short-lived PR. Shared contracts land before consumers.

1. Connection contracts and credential references (the feature was removed 2026-10-20; the
   contracts remain until a contracts change removes them).
2. TasteCode API runtime with deterministic fake-transport tests (removed 2026-10-20).
3. OpenAI Responses transport and a real local end-to-end session (removed 2026-10-20).
4. Anthropic Messages transport (removed 2026-10-20).
5. OpenAI-compatible transport plus OpenRouter, Kimi, Z.ai and custom presets (removed
   2026-10-20).
6. OpenCode native adapter against captured HTTP/SSE traffic.
7. Cursor adapter against captured `stream-json` output.
8. Kimi Code through ACP; GLM Coding Plan through configured OpenCode or Claude Code.

## Definition of done

An option is not supported merely because it appears in a picker. It is done only when it
can start and continue a real session, stream normalized items, interrupt safely, report
capabilities, keep credentials out of logs and storage, and pass captured contract tests on
Windows and macOS. Unsupported actions are hidden or explained; they never fail only after
the user clicks them.
