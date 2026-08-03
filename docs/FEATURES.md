# Features

The complete list. **Deliberately not described** — we discuss each one properly when we
build it. This exists so nothing gets forgotten and so we can argue about scope in one place.

`v1` ships in the first public release · `v2` comes after · `?` undecided

---

## Projects & sessions

- [ ] `v1` Add project by folder or clone
- [ ] `v1` Auto-detect git, package manager, available agent CLIs
- [ ] `v1` Multiple projects open at once
- [ ] `v1` Multiple concurrent sessions per project
- [ ] `v1` Sessions survive app restart, reattach to running agents
- [ ] `v1` One-click git worktree per session, auto-named branch
- [ ] `v1` Safe worktree cleanup with uncommitted-work warning
- [ ] `v1` Import existing terminal sessions from disk
- [ ] `v2` Session templates (preset model + skills + instructions)
- [ ] `v2` Kanban / task board over sessions
- [ ] `?` Run two agents on the same task, compare, keep one

## Thread

- [ ] `v1` Streaming output
- [ ] `v1` First-class item types: message, reasoning, plan, command, file change, tool call, error
- [ ] `v1` Collapse/expand per item, collapsed by default for reasoning and long output
- [ ] `v1` Turn navigation (jump, fold)
- [ ] `v1` Interrupt
- [ ] `v1` Steer mid-turn (where the engine supports it)
- [ ] `v1` Edit and resend a message → forks the thread
- [ ] `v1` In-thread search
- [ ] `v1` Cross-session full-text search
- [ ] `v1` Copy message / copy code block / copy whole turn
- [ ] `v2` Auto-generated thread outline
- [ ] `v2` Image and file attachments into the prompt

## Review & safety

- [ ] `v1` Inline diff review, per file
- [ ] `v1` Per-hunk accept / reject
- [ ] `v1` Word-level diff highlighting
- [ ] `v1` Checkpoint every turn
- [ ] `v1` Restore to any checkpoint
- [ ] `v1` "What changed this session" summary
- [ ] `v1` Approval cards: command + working dir + allow once / session / pattern / deny
- [ ] `v1` Mode indicator: read-only, ask, autonomous
- [ ] `v2` Diff-first review mode
- [ ] `v2` Cost guardrail before an expensive turn

## Providers

- [ ] `v1` Setup wizard: detect CLIs, detect auth state, guide install
- [ ] `v1` Claude Code subscription
- [ ] `v1` Codex / ChatGPT subscription
- [ ] `v1` Cursor Agent
- [ ] `v1` OpenCode agent
- [ ] `v1` Kimi Code
- [ ] `v1` GLM / Z.ai coding plan
- [ ] `v1` Harness direct API agent runtime
- [ ] `v1` OpenAI API
- [ ] `v1` Anthropic API
- [ ] `v1` OpenRouter
- [ ] `v1` Kimi API
- [ ] `v1` GLM / Z.ai API
- [ ] `v1` Custom OpenAI-compatible endpoint
- [ ] `v1` Local models (Ollama / LM Studio)
- [ ] `v1` Per-session model + provider selection
- [ ] `v1` Token and cost accounting per turn / session / provider
- [ ] `v2` Grok / xAI
- [ ] `v2` Gemini CLI
- [ ] `v2` Automatic fallback when a provider hits its limit

Implementation lanes and release criteria: [PROVIDERS.md](./PROVIDERS.md).

## Extensions

- [ ] `v1` MCP servers: add, enable/disable, per-project scope, inspect tools
- [ ] `v1` Agent Skills (`SKILL.md`): browse, enable per project, install from folder
- [ ] `v1` Edit custom instruction files (`CLAUDE.md` / `AGENTS.md`)
- [ ] `v1` Slash commands
- [ ] `v2` Hooks management
- [ ] `v2` Subagent visibility
- [ ] `v2` Plugin bundles

## Design agent

- [ ] `v1` TasteSkill mode
- [ ] `v1` Live preview pane with hot reload
- [ ] `v1` Headless render + multi-viewport screenshot
- [ ] `v1` Visual critique loop (render → screenshot → critique → revise)
- [ ] `v1` Direction gallery — pick from real thumbnails
- [ ] `v1` Design token editor
- [ ] `v1` Reference board (targets and anti-references)
- [ ] `v2` Visual diff between iterations
- [ ] `v2` Font management

## Terminal & editor

- [ ] `v1` Real PTY pane per session
- [ ] `v1` Open file in your editor
- [ ] `v1` File tree for the session workspace
- [ ] `?` Built-in editor

## App

- [ ] `v1` Light + dark theme
- [ ] `v1` Density: comfortable / compact
- [ ] `v1` Font choice
- [ ] `v1` Remappable keybindings + Vim / VS Code presets
- [ ] `v1` Command palette
- [ ] `v1` Layout persistence per project
- [ ] `v1` Auto-update
- [ ] `v1` Signed installers (Windows + macOS)
- [ ] `v1` Opt-in crash reporting
- [ ] `v2` Desktop notifications when a turn completes

## Mobile — `v2`

- [ ] Session list with live status
- [ ] Push notifications (turn complete, approval needed)
- [ ] Read a thread
- [ ] Approve / deny
- [ ] Send a message / steer
- [ ] Review a diff
- [ ] Voice input
- [ ] Device pairing + biometric unlock

## Not doing

Cloud execution of your code · team/multi-user features · reselling tokens · a full IDE ·
agents that dispatch agents (v3 at the earliest)
