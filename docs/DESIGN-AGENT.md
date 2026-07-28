# Design agent

> **Empty on purpose.** Fills in at [M4](./ROADMAP.md#m4--design-agent), once TasteSkill v2
> exists.

The differentiator: a design agent that produces work you would actually ship, instead of
the gradient-hero-and-three-cards look every coding agent defaults to. Nobody else in this
category is competing on design output quality — they all compete on worktrees and kanban
boards.

**Split of responsibility:** TasteSkill v2 is authored separately by the team and carries
the judgment — directions, rules, ban lists, critique rubrics. This repo builds the runtime
around it: preview, render, screenshot, the critique loop, the token editor.

It ships as a standard `SKILL.md` package, so it also runs in Claude Code, Codex and Cursor.
That is distribution, not leakage.

Feature list: [FEATURES.md → Design agent](./FEATURES.md#design-agent).

_Everything else — the pipeline, the rubric, the eval method — gets written here when we
build it._
