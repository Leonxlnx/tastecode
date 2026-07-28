# UX principles

The premise of this product is that the client is better than the alternatives. That is not
achieved by a feature list; it is achieved by a hundred decisions that each look small.
These are the rules we hold ourselves to when making them.

---

## 1. Speed is the first feature

Nothing else registers if the app is slow. Perceived speed beats measured speed:
optimistic UI, skeletons that match final layout exactly, never a spinner where content
could appear progressively. If an operation takes more than 200ms it must show what it is
doing, not that it is doing something.

Budgets are in [`ui-performance.md`](../01-research/ui-performance.md) and enforced in CI.
A PR that regresses a budget does not merge.

## 2. Never move something the user is reading

The cardinal sin of chat UIs. Streaming must not push content, history loading must not
jump scroll, and the view must never yank back to the bottom because new tokens arrived.
End-anchored virtualization plus "follow only if already at the bottom." Non-negotiable.

## 3. The agent's state is always legible

At any moment the user knows: which agent, which model, which mode (read-only / ask /
autonomous), which directory or worktree, whether it is running, and roughly what it costs.
Ambiguity about what an autonomous process is permitted to do is the fastest way to lose
trust — and once lost it does not come back.

## 4. Everything is reversible, and reversal is obvious

Checkpoint before every turn. Restore is one click and clearly labeled. Destructive actions
name exactly what will be lost. **No confirmation dialog that a user learns to dismiss
without reading** — if it can be undone, do it and offer undo; if it truly cannot, make the
consequence concrete rather than adding a checkbox.

## 5. Progressive disclosure, aggressively

An agent thread contains enormous volumes of low-value output. Default to collapsed
summaries: `▸ ran 4 commands`, `▸ edited 3 files +42 −8`, `▸ thought for 12s`. Expansion is
one click and stays expanded for that item. The default view should read like a summary of
what happened; the detail is there when you go looking.

## 6. Density is a user preference, not our opinion

Some people want an airy, calm surface. Some want maximum information. Ship comfortable and
compact, honor both properly, and remember the choice per project.

## 7. Motion is physical, short, and load-bearing

Motion exists to explain what happened — where a panel came from, what became what.
Spring-based, 150–250ms for most transitions. Nothing decorative. Nothing that delays input.
`prefers-reduced-motion` disables all of it, and the app must still be perfectly legible
without a single animation.

## 8. Keyboard first, mouse fully supported

Every action has a shortcut. A command palette (`Ctrl/Cmd+K`) reaches everything. Focus
rings are visible and correct. But this is a graphical app for people who chose a graphical
app — nothing may be keyboard-only, and no shortcut is required to discover a feature.

## 9. Windows is not a port

Native window chrome and snap behavior. Correct DPI on mixed-DPI multi-monitor setups.
Windows-native fonts as the fallback stack. Correct path display (`D:\repo`, not `/d/repo`).
Installer, updater, and file associations that behave like a Windows app.

Two rules that follow: the Windows build is *never* the one that lags, and every screenshot
in marketing is taken on Windows.

## 10. Beautiful, but not fashionable

Nothing in the app should look like a component library's default theme. That means:
deliberate type scale with real weight contrast; a palette with a defined light source; no
gradient without a reason; shadows that agree about where the light is; whitespace as
hierarchy rather than uniform padding.

The design agent enforces this for *user* output. We hold ourselves to the same standard for
our own UI, and the same ban list applies. It would be absurd to ship a taste-driven design
agent inside a generic-looking app.

## 11. Errors are honest and actionable

When an agent fails, a CLI is missing, a token expires, or a rate limit hits: say what
happened, in plain language, and offer the next step. Never a raw stack trace, never a
toast that disappears before it can be read, never "something went wrong."

Corollary: when we do not know why something failed, say that too, and provide the log.
This audience can debug — they just need to be told the truth.

## 12. First run is a product surface

The setup wizard is the first thing every user sees and the moment most of them decide.
Detecting installed CLIs, explaining why we ask them to log in via the vendor's own tool
(see [ADR-0005](../02-decisions/ADR-0005-credentials-and-policy.md)), and reaching a first
successful agent response should feel considered — not like a form.

Target: clean Windows machine to first agent response in under five minutes.

## 13. Quiet by default

No badges, no notification dots, no "New!" ribbons, no upsell, no telemetry consent modal on
launch. The app is a workspace for concentration. It should feel calm when idle and
purposeful when working.
