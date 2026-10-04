# Design variety and integration verification — 2026-09-16

Runtime source: main `02d27955`, verified locally on Windows. The app was rebuilt and restarted
with its existing data, configuration and reference library. No Computer Use or new website
generation prompts were submitted; manual visual generation testing remains with the user.

## Merged changes

| PR                                                       | Result                                                                                                                          |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| [#1174](https://github.com/Leonxlnx/tastecode/pull/1174) | Claude Fable 5.1 appears by default, preserving live context aliases and efforts.                                               |
| [#1175](https://github.com/Leonxlnx/tastecode/pull/1175) | Normal follow-ups after Design ends stop inheriting its JSON-only report instructions.                                          |
| [#1176](https://github.com/Leonxlnx/tastecode/pull/1176) | Uniform reference-group sampling, complete generated candidate discovery, and visible motion requirements across design phases. |
| [#1167](https://github.com/Leonxlnx/tastecode/pull/1167) | Private command scratch space and safer executable lookup.                                                                      |
| [#1171](https://github.com/Leonxlnx/tastecode/pull/1171) | Desktop navigation, guest, IPC and resolved project-path checks.                                                                |

## Checks

- `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build` passed on the combined source tree.
- Full tests include 130 Design Agent, 1,494 web, 729 server, 159 desktop, and 77 Claude adapter tests.
- Real-process preview tests exercised occupied command/static ports, package-manager port flags,
  concurrent previews, and preservation of an unrelated listening site.
- The local eligible library contains 118 composition groups: 15 heroes, 27 features, 15 about,
  16 social proof, 11 CTA, 11 footer, eight FAQ, six process, five pricing and four stats.
  There are 102 paired mobile candidates. All included raster files passed the existing integrity
  parser. Generated candidates explicitly retain pending visual-inspection and pairing notes.
- The rebuilt renderer returned HTTP 200; the restarted WebSocket server returned 14 existing
  projects and `claude-fable-5-1[1m]` with low/medium/high/xhigh/max efforts. The desktop stayed
  responsive. No app crash appeared in the startup logs.

Selection tests establish equal eligibility across ten different hero groups and sampling without
replacement. Prompt checks establish that motion requirements reach every consuming phase. These
are not proof that a fresh model-generated page implements or plays its animations correctly;
that still needs live desktop/mobile review. No claim of universal error-free generation is made.

## Other PRs left open

- #1170 adds a second preload to a test that already preloads the same module on main.
- #1162–#1166 and #1168 contain broader process, credential/contract, lifecycle, diagnostics and
  performance work. Their combined platform behavior was not qualified in this integration.
- #1169 is legacy Rust/Bun configuration cleanup and was left outside this change.
- #1153 and #1132 remain drafts.

No hosted CI was started. The shared development checkout and other agents' processes were not
changed. Only this task's isolated TasteCode desktop, server and renderer were restarted.
