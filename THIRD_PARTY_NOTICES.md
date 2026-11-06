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
| `@fontsource-variable/inter` | Inter variable font | OFL-1.1 | [source](https://github.com/fontsource/font-files) |
| `@fontsource-variable/jetbrains-mono` | JetBrains Mono variable font | OFL-1.1 | [source](https://github.com/fontsource/font-files) |
| `@napi-rs/keyring` | OS credential-store integration | MIT | [source](https://github.com/Brooooooklyn/keyring-node) |
| `@opencode-ai/sdk` | OpenCode adapter client | MIT | [source](https://github.com/anomalyco/opencode) |
| `@pierre/diffs` | Pull-request diff rendering | Apache-2.0 | [source](https://github.com/pierrecomputer/pierre) |
| `@shikijs/langs` | Syntax highlighting grammars | MIT | [source](https://github.com/shikijs/shiki) |
| `@shikijs/themes` | Syntax highlighting themes | MIT | [source](https://github.com/shikijs/shiki) |
| `@streamdown/math` | Math rendering in replies | Apache-2.0 | [source](https://github.com/vercel/streamdown) |
| `@tabler/icons-react` | Interface icons | MIT | [source](https://github.com/tabler/tabler-icons) |
| `@tanstack/react-virtual` | Thread virtualization | MIT | [source](https://github.com/TanStack/virtual) |
| `@xterm/addon-fit` | Terminal sizing | MIT | [source](https://github.com/xtermjs/xterm.js) |
| `@xterm/addon-unicode11` | Terminal Unicode width support | MIT | [source](https://github.com/xtermjs/xterm.js) |
| `@xterm/addon-web-links` | Terminal link detection | MIT | [source](https://github.com/xtermjs/xterm.js) |
| `@xterm/addon-webgl` | Terminal WebGL renderer | MIT | [source](https://github.com/xtermjs/xterm.js) |
| `@xterm/xterm` | Terminal UI | MIT | [source](https://github.com/xtermjs/xterm.js) |
| `electron` | Desktop runtime | MIT | [source](https://github.com/electron/electron) |
| `electron-updater` | Desktop update client | MIT | [source](https://github.com/electron-userland/electron-builder) |
| `katex` | Math typesetting and its fonts | MIT | [source](https://github.com/KaTeX/KaTeX) |
| `micromark` | Markdown parsing | MIT | [source](https://github.com/micromark/micromark) |
| `micromark-util-decode-string` | Markdown string decoding | MIT | [source](https://github.com/micromark/micromark) |
| `node-pty` | Pseudoterminal integration | MIT | [source](https://github.com/microsoft/node-pty) |
| `parse5` | Static preview HTML parsing | MIT | [source](https://github.com/inikulin/parse5) |
| `qrcode-generator` | Phone pairing code | MIT | [source](https://github.com/kazuhikoarase/qrcode-generator) |
| `react` | Renderer UI | MIT | [source](https://github.com/facebook/react) |
| `react-dom` | Renderer DOM integration | MIT | [source](https://github.com/facebook/react) |
| `semver` | Desktop release version ordering | ISC | [source](https://github.com/npm/node-semver) |
| `shiki` | Syntax highlighting | MIT | [source](https://github.com/shikijs/shiki) |
| `streamdown` | Streaming Markdown rendering | Apache-2.0 | [source](https://github.com/vercel/streamdown) |
| `thinking-orbs` | Agent activity indicators | MIT | [source](https://github.com/Jakubantalik/thinking-orbs) |
| `ws` | WebSocket runtime | MIT | [source](https://github.com/websockets/ws) |
| `zod` | Runtime schema validation | MIT | [source](https://github.com/colinhacks/zod) |

<!-- END DIRECT RUNTIME DEPENDENCIES -->

## Incorporated material

| Project       | Use                                                             | License                                 | Source                                                                      |
| ------------- | --------------------------------------------------------------- | --------------------------------------- | --------------------------------------------------------------------------- |
| Codex         | Generated app-server protocol types                             | Apache-2.0                              | [openai/codex](https://github.com/openai/codex)                             |
| Thinking Orbs | Adapted activity-indicator source                               | [MIT](./licenses/thinking-orbs-MIT.txt) | [Jakubantalik/thinking-orbs](https://github.com/Jakubantalik/thinking-orbs) |
| cinetic       | Default Agent Skill `cinetic`, shipped unmodified               | [MIT](./licenses/cinetic-MIT.txt)       | [Leonxlnx/cinetic](https://github.com/Leonxlnx/cinetic)                     |
| taste-skill   | Default Agent Skill `design-taste-frontend`, with a local patch | [MIT](./licenses/taste-skill-MIT.txt)   | [Leonxlnx/taste-skill](https://github.com/Leonxlnx/taste-skill)             |
| taste-skill   | Design app-screen library, rules, `app.css` and `charts.js`     | [MIT](./licenses/taste-skill-MIT.txt)   | [Leonxlnx/taste-skill](https://github.com/Leonxlnx/taste-skill) v2.5        |
| cook          | Default Agent Skill `cook`, shipped unmodified                  | [MIT](./licenses/cook-MIT.txt)          | [Leonxlnx/cook](https://github.com/Leonxlnx/cook)                           |

The default Agent Skills are pinned to exact commits in `packages/default-skills/skills.json`
and ship as real files in the app's `resources/default-skills` folder, each with its own
`LICENSE`.

`design-taste-frontend` (taste-skill v2.5.0) ships without its picture library. Its photographs,
the sample photographs of its demos and hero templates, its demo icon sets, its objects kit's sample
posters and sample product specs, and the credits files that list them are not in the installer, and
TasteCode never downloads them. Three of its files are
replaced by TasteCode's own copies, which point the skill at the user's own pictures:
`SKILL.md`, `references/photos.md` and `scripts/photos.mjs`. The copies and the reasons for them are
in `packages/default-skills/patches/design-taste-frontend`. The installer holds no picture from the skill.

The release gate requires a complete top-level Apache-2.0 `LICENSE`, a clean production install,
and a license or notice file for every package in the resolved production graph. It emits only
metadata; it never copies license bodies. The reviewed license files themselves must be bundled
with each Windows and macOS distribution. When an npm package omits that file, the exact reviewed
fallback and its upstream source are recorded in `licenses/direct-runtime-dependencies.json`.
