<img src="apps/desktop/assets/tastecode-icon.png" alt="TasteCode" width="96" />

# TasteCode

> A local desktop workspace for AI coding agents, with Design Mode built in.

**Status: public beta (`0.1.0-beta.1`).** TasteCode currently supports Windows x64 and
macOS Apple Silicon. Expect beta rough edges and report them through
[GitHub Issues](https://github.com/Leonxlnx/tastecode/issues).

## What TasteCode does

TasteCode puts multiple coding agents in one desktop app while keeping orchestration,
project state, terminal access, diffs, checkpoints, and history local to your machine.

The public beta ships with:

- Codex
- Claude Code
- Grok
- provider-aware models, permissions, and session controls
- project and session search, rename, and pinning
- terminal, browser preview, attachments, git context, and readable diffs
- Design Mode for inspecting and editing web interfaces

Provider capabilities differ. TasteCode hides or degrades unavailable controls instead of
pretending every provider supports the same features.

## Download

Download the latest beta from [tastecode.dev](https://tastecode.dev).

Beta builds may be unsigned. Verify the published filename and SHA-256 checksum before
installing. Windows SmartScreen or macOS Gatekeeper may show an additional warning for
unsigned builds.

## Requirements

- Windows 10/11 x64, macOS on Apple Silicon, or Linux x64 (glibc ≥ 2.31, Wayland session)
- at least one supported provider CLI installed and signed in
- Git for project checkpoints and worktree features

### Linux

Linux is qualified on Pop!_OS 24.04 (COSMIC) and Ubuntu 24.04 (GNOME); other Wayland desktops
are best-effort. Two artifacts ship per release:

- **deb** — the primary artifact. Installs to `/opt`, registers the desktop entry and AppArmor
  profile, and declares its dependencies to apt.
- **AppImage** — portable, but needs `libfuse2` on the host and unprivileged user namespaces.
  Ubuntu 23.10+ disables unprivileged user namespaces by default
  (`kernel.apparmor_restrict_unprivileged_userns`); prefer the deb there. Without FUSE, run
  `./TasteCode-*.AppImage --appimage-extract` and launch `squashfs-root/tastecode` instead.

Credential storage needs a Secret Service provider on the session bus — GNOME and KDE ship one;
minimal or headless desktops need gnome-keyring, KWallet, or KeePassXC installed.

For local development, install Node 24 LTS and pnpm, then run:

```text
pnpm install
pnpm dev
```

## Local-first security model

The local server owns state and orchestration. Provider processes run on your machine,
credentials stay with the provider or operating-system credential store, and the renderer
does not receive raw credentials. See [SECURITY.md](./SECURITY.md) and
[rules/security.md](./rules/security.md).

## Documentation

| Document                                        | Purpose                                      |
| ----------------------------------------------- | -------------------------------------------- |
| [Architecture](./docs/ARCHITECTURE.md)          | System shape and decisions                   |
| [Providers](./docs/PROVIDERS.md)                | Integration model and provider matrix        |
| [Design Agent](./docs/DESIGN-AGENT.md)          | Design Mode behavior and acceptance criteria |
| [UI handoff](./docs/UI-HANDOFF.md)              | UI invariants and open work                  |
| [Roadmap](./docs/ROADMAP.md)                    | Product milestones                           |
| [Credits](./CREDITS.md)                         | Contributors and project references          |
| [Third-party notices](./THIRD_PARTY_NOTICES.md) | Dependency and attribution audit             |
| [Licensing](./docs/LICENSING.md)                | License status and release obligations       |

## Contributing

Read [CONTRIBUTING.md](./CONTRIBUTING.md) before opening a pull request. Keep changes small,
cross-platform, and covered by the repository checks. Product discussion and bug reports
belong in [GitHub Issues](https://github.com/Leonxlnx/tastecode/issues).

Questions and beta feedback: [hello@tasteskill.dev](mailto:hello@tasteskill.dev).

## License

Licensed under the [Apache License 2.0](./LICENSE). Third-party components remain under
their respective licenses.
