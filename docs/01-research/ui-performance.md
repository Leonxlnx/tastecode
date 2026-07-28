# Making long agent threads feel instant

**Last verified: 2026-07-28.**

The stated requirement: threads regularly exceed 200 messages, each containing streamed
markdown, code blocks, diffs, and tool output. This is the hardest engineering problem in
the client and the one most likely to determine whether the app feels premium or cheap.

---

## Why agent chat is harder than normal chat

A normal chat list is append-only with stable row heights. An agent thread is not:

1. **Rows resize constantly while streaming.** As tokens arrive, the last message grows —
   dozens or hundreds of times per turn. Naive virtualization re-measures on every delta and
   the viewport walks upward. This is *the* classic AI-chat scroll bug.
2. **Rows are enormous and heterogeneous.** A single "message" can be a 400-line diff, a
   file tree, a terminal transcript, or three sentences.
3. **Syntax highlighting is expensive.** Shiki produces beautiful output using a real
   TextMate grammar engine — and it is not free. Highlighting 50 code blocks synchronously
   on thread open will block the main thread for hundreds of milliseconds.
4. **Markdown arrives incomplete.** Mid-stream you have an unterminated code fence, a half
   written bold, a dangling link. Standard renderers either drop it or render garbage, and
   both flicker.
5. **History is prepended.** Loading older messages must not move what the user is reading.

---

## The stack that solves it

### Virtualization: TanStack Virtual, end-anchored

TanStack Virtual now ships first-class support for exactly this problem — its own
documentation frames it as "chat, AI streams, and logs don't behave like ordinary lists."

Relevant configuration:

```ts
useVirtualizer({
  count: messages.length,
  estimateSize,
  getItemKey,                 // stable ID, never index
  anchorTo: 'end',            // end-anchored: prepend-stable history
  followOnAppend: true,       // stay pinned to newest
  scrollEndThreshold: 80,     // px slack for "is the user at the bottom"
  overscan: 6,
})
```

`anchorTo: 'end'` is the key: when the viewport was pinned before the last item grew, the
size delta is applied and the end stays pinned. That single option eliminates the streaming
scroll-walk. Prepending history is stable for the same reason.

Rules we adopt:
- `followOnAppend` is **disabled the moment the user scrolls away from the bottom**, and a
  "jump to latest" affordance appears. Nothing is more hostile than a chat that yanks you back.
- `getItemKey` returns a stable message ID. Index keys break everything.
- `estimateSize` is cached per message ID in the session store, so reopening a thread does
  not re-measure from scratch.

### Streaming markdown: Streamdown

`vercel/streamdown` is a drop-in `react-markdown` replacement built for token streams. The
feature we specifically need is **unterminated block parsing** — it styles incomplete bold,
italic, code, links and headings correctly mid-stream instead of flickering between raw and
rendered. It has a streaming mode (animated caret) and a static mode (for completed
messages), Shiki-backed highlighting for 200+ languages, and tree-shakeable optional plugins
for Mermaid, LaTeX and CJK.

Note: Shiki integration is via a plugin and there is an open discussion about swapping in
`react-shiki` (vercel/streamdown#115). Evaluate both; the API surface we depend on should be
thin enough to switch.

### Syntax highlighting: Shiki, off the main thread, two-phase

1. **Phase 1 — instant:** render the code block with a cheap CSS-only treatment (correct
   monospace, background, padding, line numbers). It appears immediately and does not shift.
2. **Phase 2 — enhanced:** a Web Worker running Shiki returns highlighted HTML; swap it in.
   Because the layout box is identical, nothing reflows.

Additional discipline:
- One `Highlighter` instance, created once, with **only the languages we actually load**.
  Loading all grammars is a multi-megabyte, multi-hundred-millisecond mistake.
- Lazy-load grammars on first use, cache by language.
- Cache highlighted HTML by content hash. Agent threads repeat code constantly.
- Never highlight a block that has never been in the viewport.

### The message component contract

The single most important performance rule in the codebase:

> **A completed message is immutable and renders exactly once.**

Only the streaming tail re-renders. Concretely:
- Messages are frozen objects; a completed message's props never change identity.
- `React.memo` on the message component with a comparator that checks the message ID and a
  `version` counter, nothing else.
- Streaming deltas append to a **separate** "live tail" component that is the only thing
  re-rendering during a turn. On turn completion the tail is committed into the immutable
  list — one final re-render, then never again.
- No context, no store subscription, and no inline lambdas inside the message subtree. A
  Zustand selector that returns a new array on every store write will silently re-render
  every mounted row and undo all of the above.

### Other techniques

- **`content-visibility: auto`** with a `contain-intrinsic-size` hint on message containers:
  free skipping of off-screen render work, on top of virtualization.
- **Collapse huge blocks by default.** A 2,000-line diff renders as a summary chip with a
  "show" affordance. This is better UX *and* better performance — do it for its own sake.
- **Batch streaming deltas.** Do not set state per token. Coalesce on `requestAnimationFrame`
  (~16ms) — the user cannot perceive the difference and it cuts render count by an order of
  magnitude.
- **Never mount the full history at thread open.** Load the last N turns, fetch older on
  demand, and rely on end-anchoring to make prepends invisible.

---

## Targets (these go in CI as budgets, not aspirations)

| Metric | Budget |
| --- | --- |
| Open a 500-message thread → first paint | < 150 ms |
| Scroll a 500-message thread | 60 fps sustained, no dropped frame > 32 ms |
| Streaming turn, main-thread work per delta batch | < 4 ms |
| App cold start → interactive | < 1.5 s |
| Switch between two open sessions | < 100 ms |
| Idle memory, 5 open sessions | < 500 MB |

We should build a synthetic 1,000-message fixture thread early and keep it in the repo as a
performance test bed. Every UI PR runs against it.

---

## Persistence and search

SQLite in the server process, WAL mode, with **FTS5 for full-text search** across every
message of every session. Full-text search over months of agent history is a feature nobody
in the category does well, and SQLite gives it to us nearly free.

Schema shape: an append-only event log as the source of truth, plus derived read-model
tables for the UI. This matches how T3 Code's `OrchestrationEngine` persists events and
projects a read model, and it makes replay, checkpointing, and undo tractable.

Driver: `better-sqlite3` (synchronous, fastest in-process, well-supported on Windows) if we
stay on Node. Note it is a native module and needs prebuilds for both platforms in CI.

---

## Sources

- [Chat UIs Are Lists Until They Aren't](https://tanstack.com/blog/tanstack-virtual-chat) — TanStack blog
- [Chat | TanStack Virtual Docs](https://tanstack.com/virtual/latest/docs/chat)
- [Streamdown](https://streamdown.ai/) · [docs](https://streamdown.ai/docs) · [code blocks](https://streamdown.ai/docs/code-blocks)
- [vercel/streamdown#115 — integrate react-shiki](https://github.com/vercel/streamdown/issues/115)
- [How to speed up long lists with TanStack Virtual](https://blog.logrocket.com/speed-up-long-lists-tanstack-virtual/) — LogRocket
