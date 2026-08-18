# Third-party notices

This file records direct runtime dependencies and incorporated generated material. It is a
maintainer inventory, not a replacement for the full license texts that must accompany a
distributed build.

## Direct runtime dependencies

The table below is generated from `licenses/direct-runtime-dependencies.json` and checked by
`pnpm licenses:verify`. Every shipped transitive dependency is also inspected by that command.

<!-- BEGIN DIRECT RUNTIME DEPENDENCIES -->
<!-- prettier-ignore -->
| npm package | Use | Reviewed license | Source |
| --- | --- | --- | --- |
| `@anthropic-ai/claude-agent-sdk` | Claude Code adapter runtime | LicenseRef-Anthropic-Commercial-Terms | [source](https://github.com/anthropics/claude-agent-sdk-typescript) |
| `@fontsource-variable/geist` | Geist variable font | OFL-1.1 | [source](https://github.com/fontsource/font-files) |
| `@fontsource-variable/geist-mono` | Geist Mono variable font | OFL-1.1 | [source](https://github.com/fontsource/font-files) |
| `@fontsource-variable/jetbrains-mono` | JetBrains Mono variable font | OFL-1.1 | [source](https://github.com/fontsource/font-files) |
| `@napi-rs/keyring` | OS credential-store integration | MIT | [source](https://github.com/Brooooooklyn/keyring-node) |
| `@opencode-ai/sdk` | OpenCode adapter client | MIT | [source](https://github.com/anomalyco/opencode) |
| `@pierre/diffs` | Pull-request diff rendering | Apache-2.0 | [source](https://github.com/pierrecomputer/pierre) |
| `@tanstack/react-virtual` | Thread virtualization | MIT | [source](https://github.com/TanStack/virtual) |
| `@xterm/addon-fit` | Terminal sizing | MIT | [source](https://github.com/xtermjs/xterm.js) |
| `@xterm/addon-unicode11` | Terminal Unicode width support | MIT | [source](https://github.com/xtermjs/xterm.js) |
| `@xterm/addon-web-links` | Terminal link detection | MIT | [source](https://github.com/xtermjs/xterm.js) |
| `@xterm/addon-webgl` | Terminal WebGL renderer | MIT | [source](https://github.com/xtermjs/xterm.js) |
| `@xterm/xterm` | Terminal UI | MIT | [source](https://github.com/xtermjs/xterm.js) |
| `border-beam` | Animated border effect | MIT | [source](https://github.com/Jakubantalik/border-beam) |
| `electron` | Desktop runtime | MIT | [source](https://github.com/electron/electron) |
| `electron-updater` | Desktop update client | MIT | [source](https://github.com/electron-userland/electron-builder) |
| `lucide-react` | Interface icons | ISC AND MIT | [source](https://github.com/lucide-icons/lucide) |
| `micromark` | Markdown parsing | MIT | [source](https://github.com/micromark/micromark) |
| `micromark-util-decode-string` | Markdown string decoding | MIT | [source](https://github.com/micromark/micromark) |
| `node-pty` | Pseudoterminal integration | MIT | [source](https://github.com/microsoft/node-pty) |
| `react` | Renderer UI | MIT | [source](https://github.com/facebook/react) |
| `react-dom` | Renderer DOM integration | MIT | [source](https://github.com/facebook/react) |
| `shiki` | Syntax highlighting | MIT | [source](https://github.com/shikijs/shiki) |
| `streamdown` | Streaming Markdown rendering | Apache-2.0 | [source](https://github.com/vercel/streamdown) |
| `thinking-orbs` | Agent activity indicators | MIT | [source](https://github.com/Jakubantalik/thinking-orbs) |
| `ws` | WebSocket runtime | MIT | [source](https://github.com/websockets/ws) |
| `zod` | Runtime schema validation | MIT | [source](https://github.com/colinhacks/zod) |

<!-- END DIRECT RUNTIME DEPENDENCIES -->

## Incorporated material

| Project       | Use                                 | License                                 | Source                                                                      |
| ------------- | ----------------------------------- | --------------------------------------- | --------------------------------------------------------------------------- |
| Codex         | Generated app-server protocol types | Apache-2.0                              | [openai/codex](https://github.com/openai/codex)                             |
| Thinking Orbs | Adapted activity-indicator source   | [MIT](./licenses/thinking-orbs-MIT.txt) | [Jakubantalik/thinking-orbs](https://github.com/Jakubantalik/thinking-orbs) |

The release gate requires a complete top-level Apache-2.0 `LICENSE`, a clean production install,
and a license or notice file for every package in the resolved production graph. It emits only
metadata; it never copies license bodies. The reviewed license files themselves must be bundled
with each Windows and macOS distribution. When an npm package omits that file, the exact reviewed
fallback and its upstream source are recorded in `licenses/direct-runtime-dependencies.json`.
