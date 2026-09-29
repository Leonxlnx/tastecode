# Example Agent Skills

These folders are optional examples for TasteCode's project-level Agent Skills workflow. TasteCode does not install or enable them automatically.

## Install an example

1. Open a project in TasteCode.
2. Open **Settings** and select **Agent Skills**.
3. Choose **Install from folder**.
4. Select the folder for the skill you want to add.
5. Enable the skill for the project if needed.
6. Open the skill picker from the composer or use the invocation syntax supported by the active provider.

TasteCode validates the selected folder and copies it into the project's managed `.agents/skills` directory. Keep each skill's `SKILL.md` and supporting files together.

## Included examples

### Copywriting

[`copywriting/`](./copywriting/) provides a provider-neutral workflow for writing and rewriting website, app, blog, product, email, documentation, and interface copy. It focuses on clear language, factual accuracy, sentence variety, practical SEO, accessibility, protected content, and avoiding common AI patterns such as redundant eyebrow headings and decorative numbering.

The skill has no external dependencies. The optional `agents/openai.yaml` file adds display metadata for OpenAI and Codex clients but is not required by the core skill.
