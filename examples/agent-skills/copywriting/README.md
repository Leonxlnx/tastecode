# Copywriting

A reusable Agent Skill for writing and rewriting websites, apps, blogs, portfolios, case studies, product copy, emails, documentation, and interface text in a clear, natural, direct voice. It also removes common AI patterns such as redundant eyebrow headings and decorative numbered sections.

## Included files

- `SKILL.md`: Core workflow and rules
- `references/style-guide.md`: Detailed sentence and editing guidance
- `references/content-types.md`: Rules for websites, apps, blogs, case studies, and related formats
- `references/examples.md`: Before-and-after examples using fictional or generic scenarios
- `references/quality-checklist.md`: Final review checklist
- `agents/openai.yaml`: Optional OpenAI and Codex display metadata

## Use with TasteCode

1. Open a project in TasteCode.
2. Open **Settings** and select **Agent Skills**.
3. Choose **Install from folder**.
4. Select this `copywriting` folder.
5. Enable the skill for the project if it is not already enabled.
6. Open the skill picker from the composer or invoke the skill using the syntax supported by the active provider.

TasteCode copies the complete folder into the project's managed Agent Skills directory, including the supporting reference files.

## Use with other compatible agents

Copy the complete `copywriting` folder into the user-level or project-level Agent Skills directory supported by the agent. Keep `SKILL.md`, `references/`, and any metadata files together so relative references continue to work.

Direct invocation syntax varies by provider. For example, Codex supports:

```text
$copywriting
```

## Example prompts

```text
Use the Copywriting skill to rewrite the public website copy in this repository. Preserve all facts, pricing, testimonials, routes, and functionality.
```

```text
Use the Copywriting skill to draft a service page for a commercial cleaning company. Keep it direct, specific, and aligned with the actual search intent.
```

```text
Use the Copywriting skill to review this app's onboarding, empty states, buttons, and errors. Edit only the interface copy.
```

```text
Use the Copywriting skill to write a practical blog post from this outline. Answer the main question early and remove generic marketing language.
```
