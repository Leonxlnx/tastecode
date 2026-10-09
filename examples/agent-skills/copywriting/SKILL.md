---
name: copywriting
description: Write or rewrite website, app, blog, portfolio, case study, landing page, product, email, documentation, and interface copy in a concise, natural, direct voice. Use when copy should sound human, preserve facts and structure, avoid marketing fluff and AI clichés, vary sentence openings, remove redundant eyebrow headings, limit decorative numbering, and follow practical SEO without keyword stuffing. Preserve legal language, quoted testimonials, pricing, and other protected copy unless the user explicitly includes it in scope.
---

# Copywriting

Write clear, natural copy that sounds like a knowledgeable person explaining the subject. Keep the substance. Remove the performance.

## Default writing standard

Use these priorities in order:

1. Preserve facts, meaning, and user constraints.
2. Make the copy easy to understand.
3. Sound natural and specific.
4. Remove unnecessary words.
5. Support the page or product goal.
6. Apply SEO without making the copy sound optimized.

The default voice is professional, plainspoken, confident, and practical. It may have personality, but it should not sound like a slogan, a pitch deck, or an AI writing sample.

## Core rules

- Use direct language and familiar words.
- Write in the language requested by the user or established by the source.
- Preserve brand names, product names, technical terms, and proper nouns unless translation or renaming is explicitly requested.
- Prefer specific nouns and verbs over broad claims and adjectives.
- Keep sentences complete. Concise does not mean clipped.
- Use active voice when it reads naturally.
- Use contractions when they fit the speaker or brand.
- Keep paragraphs focused, usually one to three sentences for web and app copy.
- Vary sentence length enough to avoid a repetitive rhythm.
- Do not use em dashes. Use a period, comma, colon, or parentheses instead.
- Keep headings short, literal, and descriptive.
- Do not add an eyebrow, overline, kicker, preheader, or small category label above a heading by default. Remove it when it repeats the heading or nearby navigation.
- Keep a compact label only for useful metadata, a true process step, an explicit user request, or an established, locked design system.
- Use numbering only when order, rank, count, or reference matters. Do not number unordered cards, services, benefits, projects, or sections for decoration.
- Use `1`, `2`, and `3`, not `01`, `02`, and `03`, unless leading zeroes are part of a real identifier, standard, timestamp, locked design, or explicit request.
- State what something is, who it is for, what it does, and what the reader should do next.
- Preserve necessary industry terms, product names, specifications, qualifiers, and compliance language.
- Never invent results, metrics, customer claims, credentials, locations, services, or technical details.
- Avoid assumptions about identity, ability, family structure, culture, location, technical knowledge, or access needs.
- Treat quoted testimonials, legal and compliance text, pricing, safety instructions, accessibility requirements, approved copy, and other protected content as locked unless the user explicitly includes it in scope.

## First-person sentence openings

First-person copy should still sound personal. Keep some sentences that begin with `I`, but do not let several nearby sentences begin the same way.

For sections longer than three sentences, a useful default is no more than about one sentence in three beginning with `I`. Treat this as a naturalness check, not a fixed quota.

Create variety by starting with:

- Context: `At Acme Corporation, I coordinate customer research and product launches.`
- Time: `Before joining the product team, I worked in customer support.`
- Subject: `The role also includes maintaining the help center.`
- Project: `Each guide starts with the questions users ask most.`
- Purpose: `To keep the instructions useful, I review them after each release.`
- Condition: `When the existing workflow caused delays, I simplified the review steps.`
- Experience: `Over several years, I helped teams improve their onboarding process.`
- Gerund phrase: `Understanding the audience helps me choose the right level of detail.`
- Result: `The updated workflow gives the team one place to review changes.`

Do not force passive voice or awkward introductory clauses just to avoid `I`. The sentence should still sound like something a person would say.

## Phrases and patterns to avoid

Remove these by default unless the context genuinely requires them:

- Empty marketing verbs such as `elevate`, `unlock`, `empower`, `transform`, and `reimagine`
- Generic praise such as `cutting-edge`, `best-in-class`, `world-class`, `robust`, and `game-changing`
- Soft filler such as `seamless`, `innovative`, `dynamic`, `impactful`, and `meaningful` when no specific meaning follows
- Generic openings such as `In today's fast-paced world`
- Contrast formulas such as `This is X, not Y`
- Escalation formulas such as `not just X, but Y` and `more than just`
- Decorative constructions such as `where strategy meets creativity`
- Vague promises such as `take your business to the next level`
- AI transitions such as `Additionally`, `Furthermore`, and `Moreover` when a normal sentence transition works
- Meta claims such as `This approach ensures` when the result can be stated directly
- Forced groups of three benefits that repeat the same idea
- Decorative eyebrow headings that repeat the page or section heading
- Numbered cards, sections, or list items whose numbers do not communicate sequence, rank, count, or reference
- Leading-zero labels such as `01`, `02`, and `03` used only for visual style
- Metaphors that make simple work sound dramatic
- Cute error messages or interface labels that delay the answer

Do not replace one cliché with another. Replace it with a fact, action, result, or clear explanation.

## Rewrite workflow

### 1. Identify the job

Determine:

- Content type
- Audience
- Main question or task
- Desired action
- Voice and point of view
- Facts that must remain
- Words or fields that are locked
- SEO topic or search intent, when applicable
- Character, layout, or CMS constraints

Use the available context and repository before asking questions. Ask only when missing information would materially change the result.

### 2. Protect the source

When rewriting existing copy:

- Preserve the core nouns, verbs, claims, facts, and qualifiers.
- Make the smallest useful change before replacing whole passages.
- Reorder clauses when that improves flow.
- Keep approved terminology consistent.
- Preserve links, IDs, keys, arrays, code behavior, form behavior, and field structure.
- When a heading or sentence is split across fields, verify the complete rendered text.
- Do not change design, layout, functionality, or information architecture unless requested.

When working in a repository, read its instruction files, such as `AGENTS.md`, `CLAUDE.md`, or the project equivalent, before editing. Locate the real content source, including CMS data, fallback content, localization files, or hard-coded strings.

### 3. Draft the direct version

For each section:

1. Lead with the answer or main subject.
2. Add only the context needed to understand it.
3. Use concrete details already supported by the source.
4. End with the next step only when the section needs one.

Do not add an inspirational setup before the useful information.

### 4. Run the sentence-opening pass

Review nearby sentences, headings, cards, and bullets.

- Break up repeated `I`, `We`, `This`, `Our`, and `The` openings.
- Keep variation natural.
- Avoid starting every sentence with a transition or dependent clause.
- Check repeated sentence structures, not only repeated first words.

### 5. Run the AI-pattern pass

Search for:

- Slogans
- Unnecessary metaphors
- Contrast formulas
- Inflated adjectives
- Generic benefit statements
- Overwritten transitions
- Repetitive three-part lists
- Redundant eyebrow, overline, kicker, or preheader labels
- Decorative numbering and unnecessary leading zeroes
- Claims that could apply to any company
- Conclusions that only repeat the introduction

Replace each one with a fact, a clear action, a specific result, or nothing.

### 6. Apply the content-type rules

Use `references/content-types.md` for websites, apps, blogs, case studies, portfolios, and technical content.

### 7. Apply the SEO pass when relevant

- Match the actual search intent.
- Use the main topic naturally in the title, H1, opening copy, and a descriptive heading when it fits.
- Keep titles and meta descriptions unique, accurate, and readable.
- Answer the likely query early.
- Use descriptive internal-link text.
- Include locations only when the organization actually serves them.
- Avoid keyword repetition, doorway copy, vague location swapping, and SEO filler.
- Do not add unsupported claims to make a page sound more authoritative.

SEO should improve clarity and findability without changing the natural voice.

### 8. Complete the final check

Use `references/quality-checklist.md` before delivering or committing the copy.

## Output modes

Choose the mode that matches the request.

### New draft

Provide finished copy organized by page, screen, section, or content block. Include titles, headings, body copy, CTAs, and metadata when requested.

### Rewrite

Return replacement copy in the same structure as the source. When useful, identify exact fields or components so the changes are ready to paste or implement.

### Repository edit

Edit only the requested copy. Preserve application behavior and locked content. Run the relevant lint, build, content, or browser checks available in the project. Report the files and content records changed.

### Review

Identify the highest-impact problems, then provide revised copy. Do not spend most of the response describing the problem when a replacement would be more useful.

### Incremental patch

When an earlier version has already been implemented, provide only the new changes. Clearly state that all unlisted copy remains unchanged.

## Handling tone requests

Keep this voice as the baseline, then adjust without losing clarity:

- More casual: use contractions and slightly shorter sentences.
- More technical: retain exact terminology and explain only what the audience may not know.
- More personal: use first person and real details, while still varying sentence openings.
- More formal: reduce contractions and casual phrasing, but do not add corporate language.
- More persuasive: strengthen relevance, proof, and next steps rather than adding hype.

## Supporting references

Read these only when they help with the current task:

- `references/style-guide.md` for detailed editing decisions and sentence-level patterns.
- `references/content-types.md` for rules by content format.
- `references/examples.md` for before-and-after calibration.
- `references/quality-checklist.md` for final review.
