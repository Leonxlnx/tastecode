# Working rules

Two people, two operating systems, one trunk. These rules exist so that neither of us is
ever blocked on the other, and so that history stays readable when this repo goes public.

Read this before your first commit.

---

## 1. Roles

| | |
| --- | --- |
| **Windows dev (Leon)** | Owns Windows shell, install/update path, PTY + process handling, Windows QA gate. Primary reviewer for anything touching `apps/desktop` or native process code. |
| **macOS dev** | Owns macOS shell, notarization/signing, macOS QA gate. Primary reviewer for anything platform-specific on Darwin. |
| **Both** | Product direction, design review, and the agent adapter layer. |
| **Claude (this agent)** | Planning, research, architecture, implementation, docs. You two stay in the loop by assigning tasks and reviewing design. |

**A change that touches platform-specific code does not merge until it has been run on both
operating systems.** Not reviewed — *run*. This is the single rule most likely to save us.

---

## 2. Branching

Trunk is `main`. `main` is always releasable and always green.

Branch names are `<type>/<area>-<short-description>`, kebab-case:

```
feat/chat-virtualized-thread-list
fix/pty-windows-conpty-resize
docs/adr-desktop-shell
chore/ci-windows-matrix
spike/acp-adapter-prototype
design/thread-view-visual-pass
```

Types: `feat`, `fix`, `docs`, `chore`, `refactor`, `perf`, `test`, `spike`, `design`.

**Branches are short-lived.** Target under two days. If a branch lives longer than three
days it is too big — split it. Rebase on `main` daily; do not let branches drift.

`spike/` branches are throwaway. They are allowed to be messy and are never merged; you
extract the learning into an ADR and delete the branch.

---

## 3. Commits — small and frequent

This is a hard preference for this project: **many small commits, not few large ones.**

- **One logical change per commit.** If the subject line needs the word "and", split it.
- **Commit when a thing works, not when a feature is done.** A commit that adds a type,
  a commit that adds the function, a commit that wires it up — three commits, not one.
- **Never mix a refactor with a behavior change.** Refactor in its own commit, first.
- **Never mix formatting with logic.** Formatting-only commits are `style:` and should be
  trivially reviewable.
- Rough calibration: if a commit's diff does not fit on one screen, ask whether it should
  have been two commits.
- Push often. An unpushed branch is invisible work, and with two people in different time
  zones, invisible work is wasted work.

### Format — Conventional Commits

```
<type>(<scope>): <imperative summary, lowercase, no trailing period>

<why this change exists — not what the diff already shows>
<constraints, tradeoffs, or things that will look wrong to a future reader>
```

Types match the branch types above. Scope is the package or area: `chat`, `adapters`,
`desktop`, `server`, `design-agent`, `ci`, `docs`.

```
feat(chat): pin scroll to bottom during token streaming

TanStack Virtual's anchorTo:'end' handles the resize storm from streaming
deltas; without it every delta re-measures the last row and the viewport
walks upward. followOnAppend stays off when the user has scrolled away.
```

Bad: `update stuff`, `fixes`, `wip`, `more work on chat`.

`wip` commits are fine *on your own branch* while you work, but the branch is cleaned up
before review — see below.

---

## 4. Pull requests

Everything reaches `main` through a PR. No direct pushes to `main`, including by the agent.

- **PRs are small.** Under ~400 changed lines is the target. A big feature is a stack of
  small PRs behind a flag, not one giant PR.
- **The PR body says why, and how it was verified.** Include screenshots or a short screen
  capture for anything visual. Design review is one of your two jobs — make it possible.
- **Draft early.** Open the PR as a draft when the branch exists, not when it is finished.
  It is the cheapest way to keep the other person oriented.
- **One approval required** from the other human. The agent may open and update PRs; it
  does not approve them.
- **Merge strategy: squash-merge**, with the PR title as the final commit subject.
  Small commits are for *working and reviewing*; `main` keeps one clean commit per PR.
  This is deliberate: it gives us granular history during review and a bisectable trunk.
- Delete the branch on merge.

### Cleaning up before review

Interactive rebase is unavailable in this environment for the agent, so:
squash noise on your own branch with `git reset --soft` + recommit, or just leave it —
squash-merge collapses it anyway. Never rewrite history on a branch someone else has
pulled.

---

## 5. CI gates

`main` and every PR must pass, on **both** `windows-latest` and `macos-latest`:

1. typecheck
2. lint + format check
3. unit tests
4. build (desktop bundle builds, not necessarily signed)

Plus, on PRs that touch the UI: a visual smoke run that boots the app and screenshots key
views. A broken Windows build blocks the merge even if macOS is green, and vice versa.

---

## 6. Cross-platform rules (non-negotiable)

These are the things that silently break a two-OS team.

- **Line endings:** enforced by `.gitattributes`. Never `git config core.autocrlf true`.
- **Paths:** never build a path with string concatenation and never hardcode `/` or `\`.
  Use `node:path`. Never assume a POSIX shell exists.
- **Scripts:** all repo scripts are Node/TypeScript, not `.sh`. If a task needs a shell,
  it needs two implementations or it needs to be a Node script.
- **Case sensitivity:** macOS is case-insensitive by default, Linux CI is not. Import paths
  must match file names exactly. CI on Linux catches this; do not ignore it.
- **Reserved names:** never create files named `con`, `aux`, `nul`, `prn`, `com1`–`com9`,
  `lpt1`–`lpt9` — Windows cannot check them out and the repo becomes uncloneable.
- **Path length:** Windows historically caps at 260 chars. Keep directory nesting shallow;
  worktrees + `node_modules` eat the budget fast.
- **Symlinks:** avoid committing them. Windows needs Developer Mode or admin to create them.

---

## 7. Secrets

- No credential, token, API key, or `.env` ever gets committed. `.gitignore` covers the
  obvious cases; that is a safety net, not a policy.
- Runtime credentials live in the OS credential store (Windows Credential Manager / DPAPI,
  macOS Keychain), never in a plaintext JSON file we write.
- We never transmit a user's credentials to any server we control. See
  [PROVIDERS.md §1](./PROVIDERS.md#1-the-rule) — this is a legal constraint, not just a
  security preference.

---

## 8. Documentation rules

**There are nine documents. Keep it that way.** Add to the right one rather than creating a
tenth. A new top-level doc needs a reason you can say out loud.

- **Every non-obvious decision goes in [ARCHITECTURE.md](./ARCHITECTURE.md), with the
  rejected alternatives written down.** The rejected options are the valuable part; without
  them we re-litigate the same decision in three months.
- To change a decision, edit it in place and add a row to the change log at the bottom of
  that file. Never quietly diverge in code.
- Anything with an external source carries a **"last verified" date** —
  [RESEARCH.md](./RESEARCH.md) and [PROVIDERS.md](./PROVIDERS.md) both move monthly.
- If behavior differs between Windows and macOS, that difference is documented at the code,
  not discovered later by the other person.

---

## 9. Working with the agent

- Tasks come from you two; the agent plans and executes. When the agent hits an ambiguity
  that changes the shape of the work, it asks. When it hits one that does not, it decides,
  proceeds, and flags the assumption in the PR.
- The agent opens draft PRs early so you can redirect before the work is finished.
- Design review is human. The agent will produce visuals; you decide whether they are good.
