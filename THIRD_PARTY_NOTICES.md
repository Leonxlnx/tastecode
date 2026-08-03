# Third-party notices

This file records direct runtime dependencies and incorporated generated material. It is a
maintainer inventory, not a replacement for the full license texts that must accompany a
distributed build.

| Project                             | Use                                 | License                                     | Source                                                                      |
| ----------------------------------- | ----------------------------------- | ------------------------------------------- | --------------------------------------------------------------------------- |
| Codex                               | Generated app-server protocol types | Apache-2.0                                  | [openai/codex](https://github.com/openai/codex)                             |
| React and React DOM                 | Renderer                            | MIT                                         | [facebook/react](https://github.com/facebook/react)                         |
| Electron                            | Desktop runtime                     | MIT                                         | [electron/electron](https://github.com/electron/electron)                   |
| Streamdown                          | Streaming Markdown                  | Apache-2.0                                  | [vercel/streamdown](https://github.com/vercel/streamdown)                   |
| Shiki                               | Syntax highlighting                 | MIT                                         | [shikijs/shiki](https://github.com/shikijs/shiki)                           |
| TanStack Virtual                    | Thread virtualization               | MIT                                         | [TanStack/virtual](https://github.com/TanStack/virtual)                     |
| xterm.js and addon-fit              | Terminal UI                         | MIT                                         | [xtermjs/xterm.js](https://github.com/xtermjs/xterm.js)                     |
| Lucide                              | Interface icons                     | ISC; some icons include Feather's MIT terms | [lucide-icons/lucide](https://github.com/lucide-icons/lucide)               |
| Geist and Geist Mono via Fontsource | Fonts                               | OFL-1.1                                     | [fontsource/font-files](https://github.com/fontsource/font-files)           |
| Border Beam                         | Animated border effect              | MIT                                         | [Jakubantalik/border-beam](https://github.com/Jakubantalik/border-beam)     |
| Thinking Orbs                       | Agent activity indicators           | MIT                                         | [Jakubantalik/thinking-orbs](https://github.com/Jakubantalik/thinking-orbs) |
| node-pty                            | Pseudoterminal integration          | MIT                                         | [microsoft/node-pty](https://github.com/microsoft/node-pty)                 |
| keyring-node                        | OS credential-store integration     | MIT                                         | [Brooooooklyn/keyring-node](https://github.com/Brooooooklyn/keyring-node)   |
| ws                                  | WebSocket runtime                   | MIT                                         | [websockets/ws](https://github.com/websockets/ws)                           |
| Zod                                 | Runtime schema validation           | MIT                                         | [colinhacks/zod](https://github.com/colinhacks/zod)                         |

Transitive dependencies are pinned in `pnpm-lock.yaml`. Before the first distributable
release, generate a production dependency license report from a clean `pnpm install`,
review it, and bundle every required license and notice with the desktop artifact.
