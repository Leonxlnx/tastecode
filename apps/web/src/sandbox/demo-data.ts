import type {
  ApprovalMode,
  Capabilities,
  Item,
  McpServer,
  Model,
  PlanStep,
  ProviderCommand,
  ProviderId,
  ProviderLimit,
  ProviderStatus,
  Skill,
  ThreadInboxStatus,
  Usage,
} from '@harness/contracts'
// Thread pictures for the inbox rail, inlined as the PNG data URLs the server
// stores. harbor-site and field-notes are CC0 photographs from Wikimedia Commons
// (File:Boats-port-sailing-ships-harbor_(24243651191).jpg by Ed Gregory and
// File:A_notebook.jpg by Jan Kahánek), cropped to 64px squares; tastecode is
// the app's own icon. They stand in for logos a user would add.
import harborSiteImage from './thread-images/harbor-site.png?inline'
import fieldNotesImage from './thread-images/field-notes.png?inline'
import tastecodeImage from './thread-images/tastecode.png?inline'

/**
 * The made-up world the design sandbox shows: three signed-in providers,
 * a few projects and chats with finished transcripts. Nothing here is read
 * from or sent to a real provider; every name, number and file is invented.
 */

export type DemoPlatform = 'win32' | 'darwin' | 'linux'

export function detectDemoPlatform(): DemoPlatform {
  const agent = typeof navigator === 'undefined' ? '' : navigator.userAgent
  if (/Mac OS X|Macintosh/.test(agent)) return 'darwin'
  if (/Linux|X11/.test(agent) && !/Windows/.test(agent)) return 'linux'
  return 'win32'
}

export function demoHome(platform: DemoPlatform): string {
  if (platform === 'win32') return 'C:\\Users\\demo'
  return platform === 'darwin' ? '/Users/demo' : '/home/demo'
}

export function demoJoin(platform: DemoPlatform, ...parts: string[]): string {
  return parts.join(platform === 'win32' ? '\\' : '/')
}

/** One provider as the sandbox presents it: signed in, with models and limits. */
export type DemoProvider = {
  status: ProviderStatus
  models: Model[]
  email: string
  plan: string
  limits: (now: number) => ProviderLimit[]
  commands: ProviderCommand[]
  skills: (home: string, platform: DemoPlatform) => Skill[]
  mcp: McpServer[]
  /** The tool its dummy answers call, named the way the provider names it. */
  tool: string
}

const FULL_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']

function model(
  id: string,
  displayName: string,
  description: string,
  reasoningEfforts: string[],
  extra: Partial<Model> = {},
): Model {
  return {
    id,
    displayName,
    description,
    isDefault: false,
    reasoningEfforts,
    serviceTiers: [],
    ...(reasoningEfforts.length > 0 ? { defaultReasoningEffort: 'high' } : {}),
    ...extra,
  }
}

const DIRECT_SOURCE = { agent: 'optional', connection: false, direct: true } as const

const CLAUDE_CAPABILITIES: Capabilities = {
  steer: true,
  fork: false,
  interrupt: true,
  reasoningItems: true,
  approvals: true,
  userInput: true,
  autoReview: true,
  images: true,
  subagents: 'progress',
  multipleAccounts: true,
  context: {
    windows: [200_000, 1_000_000],
    compaction: true,
    compactionOff: true,
    defaultCompactAt: 93,
    latestCompactAt: 93,
  },
}

const CODEX_CAPABILITIES: Capabilities = {
  steer: true,
  fork: true,
  interrupt: true,
  reasoningItems: true,
  approvals: true,
  userInput: true,
  autoReview: true,
  images: true,
  subagents: 'progress',
  multipleAccounts: true,
  context: {
    windows: [272_000, 872_000],
    compaction: true,
    compactionOff: false,
    defaultCompactAt: 90,
    latestCompactAt: 90,
  },
}

const GROK_CAPABILITIES: Capabilities = {
  steer: false,
  fork: false,
  interrupt: true,
  reasoningItems: true,
  approvals: false,
  images: true,
  subagents: 'progress',
  context: { windows: [256_000], compaction: true, compactionOff: false, defaultCompactAt: 80 },
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

function noTools(): Pick<McpServer, 'resources' | 'resourceTemplates'> {
  return { resources: [], resourceTemplates: [] }
}

function folderSkill(
  home: string,
  platform: DemoPlatform,
  folder: string,
  name: string,
  description: string,
  enabled = true,
): Skill {
  return {
    id: `skill:${folder}:${name}`,
    name,
    description,
    source: { type: 'folder', path: demoJoin(platform, home, folder, 'skills', name) },
    scope: 'user',
    enabled,
    dependencyErrors: [],
  }
}

export const DEMO_PROVIDERS: ReadonlyArray<DemoProvider> = [
  {
    status: {
      id: 'claude-code',
      displayName: 'Claude Code',
      installed: true,
      version: '2.4.0 (sandbox)',
      auth: 'authenticated',
      capabilities: CLAUDE_CAPABILITIES,
      setup: { installUrl: 'https://example.com/claude-code', login: 'provider' },
      source: DIRECT_SOURCE,
    },
    models: [
      model('claude-fable-5-1', 'Fable 5.1', 'Long-horizon reasoning and coding', FULL_EFFORTS),
      model('claude-opus-5-5', 'Opus 5.5', 'Deep reasoning', FULL_EFFORTS, { isDefault: true }),
      model('claude-sonnet-5-5', 'Sonnet 5.5', 'Balanced speed and capability', FULL_EFFORTS),
      model('claude-haiku-5-5', 'Haiku 5.5', 'Fastest and cheapest', ['low', 'medium', 'high']),
    ],
    email: 'designer@example.com',
    plan: 'max',
    limits: (now) => [
      {
        id: 'five_hour',
        label: 'Current session',
        usedPercent: 38,
        resetsAt: now + 2 * HOUR + 14 * 60_000,
        windowMinutes: 300,
      },
      {
        id: 'seven_day',
        label: 'Weekly limit',
        usedPercent: 61,
        resetsAt: now + 3 * DAY + 5 * HOUR,
        windowMinutes: 7 * 24 * 60,
      },
    ],
    commands: [
      {
        name: 'compact',
        description: 'Summarize the conversation to free context',
        kind: 'command',
        source: 'builtin',
      },
      { name: 'context', description: 'Show what fills the context window', source: 'builtin' },
      {
        name: 'review',
        description: 'Review the changes on this branch',
        kind: 'skill',
        source: 'builtin',
      },
      {
        name: 'design-taste',
        description: 'Art direction and a look-and-fix loop for UI work',
        kind: 'skill',
        source: 'plugin',
      },
      {
        name: 'release-notes',
        description: 'Draft release notes from merged pull requests',
        argumentHint: '<version>',
        kind: 'command',
        source: 'custom',
      },
    ],
    skills: (home, platform) => [
      folderSkill(
        home,
        platform,
        '.claude',
        'design-taste',
        'Art direction and a look-and-fix loop for UI work',
      ),
      folderSkill(
        home,
        platform,
        '.claude',
        'release-notes',
        'Draft release notes from merged pull requests',
      ),
      folderSkill(home, platform, '.claude', 'pdf', 'Read, fill and merge PDF files', false),
    ],
    mcp: [
      {
        id: 'github',
        displayName: 'GitHub',
        scope: 'global',
        enabled: true,
        auth: { status: 'authenticated', method: 'oauth' },
        startup: { state: 'ready' },
        tools: [
          {
            name: 'search_issues',
            description: 'Search issues and pull requests',
            inputSchema: { type: 'object' },
          },
          {
            name: 'get_pull_request',
            description: 'Read one pull request',
            inputSchema: { type: 'object' },
          },
        ],
        ...noTools(),
      },
      {
        id: 'figma',
        displayName: 'Figma',
        scope: 'project',
        enabled: true,
        auth: { status: 'sign_in_required', method: 'oauth' },
        startup: { state: 'stopped' },
        tools: [],
        ...noTools(),
      },
    ],
    tool: 'Grep',
  },
  {
    status: {
      id: 'codex',
      displayName: 'Codex',
      installed: true,
      version: '0.130.0 (sandbox)',
      auth: 'authenticated',
      capabilities: CODEX_CAPABILITIES,
      setup: { installUrl: 'https://example.com/codex', login: 'provider' },
      source: DIRECT_SOURCE,
    },
    models: [
      model('gpt-5.6-sol', 'GPT-5.6 Sol', 'Frontier agentic coding', FULL_EFFORTS.slice(0, 4), {
        isDefault: true,
        defaultReasoningEffort: 'medium',
        serviceTiers: [
          { id: 'priority', name: 'Fast', description: 'Faster answers at a higher rate' },
        ],
      }),
      model('gpt-5.6-terra', 'GPT-5.6 Terra', 'Everyday coding', FULL_EFFORTS.slice(0, 4), {
        defaultReasoningEffort: 'medium',
      }),
      model('gpt-5.5', 'GPT-5.5', 'Previous generation', ['low', 'medium', 'high'], {
        defaultReasoningEffort: 'medium',
      }),
    ],
    email: 'designer@example.com',
    plan: 'pro',
    limits: (now) => [
      {
        id: 'codex:primary',
        label: '5-hour limit',
        usedPercent: 12,
        resetsAt: now + 4 * HOUR + 2 * 60_000,
        windowMinutes: 300,
      },
      {
        id: 'codex:secondary',
        label: 'Weekly limit',
        usedPercent: 44,
        resetsAt: now + 5 * DAY,
        windowMinutes: 7 * 24 * 60,
      },
    ],
    commands: [
      {
        name: 'review',
        description: 'Review the working tree',
        kind: 'command',
        source: 'builtin',
      },
      { name: 'diff', description: 'Show the changes in this session', source: 'builtin' },
      {
        name: 'web-design',
        description: 'Build pages from reviewed references',
        kind: 'skill',
        source: 'custom',
      },
    ],
    skills: (home, platform) => [
      folderSkill(home, platform, '.codex', 'web-design', 'Build pages from reviewed references'),
    ],
    mcp: [],
    tool: 'shell',
  },
  {
    status: {
      id: 'grok',
      displayName: 'Grok',
      installed: true,
      version: '1.8.2 (sandbox)',
      auth: 'authenticated',
      capabilities: GROK_CAPABILITIES,
      setup: { installUrl: 'https://example.com/grok', login: 'provider' },
      source: DIRECT_SOURCE,
    },
    models: [
      model('grok-4.7', 'Grok 4.7', 'Reasoning and code', [], { isDefault: true }),
      model('grok-4.6', 'Grok 4.6', 'Previous generation', []),
    ],
    email: 'designer@example.com',
    plan: 'SuperGrok',
    limits: (now) => [
      {
        id: 'grok:weekly',
        label: 'Weekly limit',
        usedPercent: 22,
        resetsAt: now + 6 * DAY,
        windowMinutes: 7 * 24 * 60,
      },
    ],
    commands: [],
    skills: () => [],
    mcp: [],
    tool: 'search_files',
  },
]

export function demoProvider(id: ProviderId): DemoProvider | undefined {
  return DEMO_PROVIDERS.find((entry) => entry.status.id === id)
}

/** An item as a transcript script writes it; the server adds identity and time. */
export type DemoItem = Omit<Item, 'id' | 'turnId' | 'status' | 'createdAt'> & {
  status?: Item['status']
}

export type DemoUsage = Omit<Usage, 'cumulative' | 'inputIncludesCached'>

export type DemoTurn = {
  prompt: string
  /** How long before "now" the turn started. */
  agoMs: number
  durationMs: number
  items: DemoItem[]
  plan?: PlanStep[]
  diff?: string
  usage?: DemoUsage
}

export type DemoChat = {
  id: string
  title: string
  provider: ProviderId
  model: string
  effort?: string
  approval: ApprovalMode
  pinned?: boolean
  unread?: boolean
  /** The state the inbox shows until the chat's first turn in the sandbox. */
  status?: ThreadInboxStatus
  /** When the chat started, for a chat with no finished turns. */
  createdAgoMs?: number
  worktreeBranch?: string
  /** The chat's picture, a PNG data URL. */
  image?: string
  /** Where the inbox files it: snoozed until 09:00 tomorrow, or settled a while ago. */
  lifecycle?: { state: 'snoozed' } | { state: 'settled'; agoMs: number }
  turns: DemoTurn[]
}

export type DemoFile = { path: string; content: string }

export type DemoProject = {
  name: string
  branch: string
  branches: string[]
  pinned: boolean
  createdAgoMs: number
  files: DemoFile[]
  chats: DemoChat[]
}

function toolCall(name: string, args: Record<string, unknown>, output: string): DemoItem {
  return { type: 'tool_call', text: `${name}\n${JSON.stringify(args)}\n${output}` }
}

function assistant(text: string): DemoItem {
  return { type: 'message', role: 'assistant', phase: 'final_answer', text }
}

const FOCUS_RING_DIFF = `diff --git a/apps/web/src/styles/focus-ring.css b/apps/web/src/styles/focus-ring.css
--- a/apps/web/src/styles/focus-ring.css
+++ b/apps/web/src/styles/focus-ring.css
@@ -12,4 +12,5 @@
 .composer:focus-within {
-  outline: 2px solid var(--accent);
-  outline-offset: 2px;
+  outline: 2px solid color-mix(in srgb, var(--accent) 55%, transparent);
+  outline-offset: 1px;
+  box-shadow: inset 0 0 0 1px var(--line-strong);
 }
`

const SIDEBAR_SPACING_DIFF = `diff --git a/apps/web/src/styles/app.css b/apps/web/src/styles/app.css
--- a/apps/web/src/styles/app.css
+++ b/apps/web/src/styles/app.css
@@ -402,7 +402,7 @@
 .sessrow {
-  padding: 5px 10px;
+  padding: 4px 8px;
   gap: 8px;
 }
@@ -517,6 +517,6 @@
 .rail__section-title {
-  margin-block: 14px 6px;
+  margin-block: 16px 8px;
 }
@@ -688,5 +688,5 @@
 .rail__footer {
-  padding-inline: 10px;
+  padding-inline: 12px;
 }
`

function usage(totalTokens: number, contextWindow: number, modelId: string): DemoUsage {
  return {
    inputTokens: Math.round(totalTokens * 0.82),
    cachedInputTokens: Math.round(totalTokens * 0.6),
    outputTokens: Math.round(totalTokens * 0.14),
    reasoningTokens: Math.round(totalTokens * 0.04),
    totalTokens,
    contextWindow,
    model: modelId,
  }
}

export const DEMO_PROJECTS: ReadonlyArray<DemoProject> = [
  {
    name: 'tastecode',
    branch: 'feat/prompt-bar-polish',
    branches: ['main', 'dev', 'feat/prompt-bar-polish', 'fix/sidebar-spacing'],
    pinned: true,
    createdAgoMs: 40 * DAY,
    files: [
      {
        path: 'README.md',
        content: '# TasteCode\n\nA desktop app for coding agents. (Sandbox copy.)\n',
      },
      {
        path: 'package.json',
        content: '{\n  "name": "tastecode",\n  "private": true\n}\n',
      },
      {
        path: 'apps/web/src/styles/focus-ring.css',
        content:
          '.composer:focus-within {\n  outline: 2px solid color-mix(in srgb, var(--accent) 55%, transparent);\n  outline-offset: 1px;\n}\n',
      },
      { path: 'apps/web/src/styles/app.css', content: '/* Sandbox copy of the app styles. */\n' },
      { path: 'apps/web/src/ui/Composer.tsx', content: 'export function Composer() {}\n' },
      { path: 'apps/web/src/ui/Sidebar.tsx', content: 'export function Sidebar() {}\n' },
      { path: 'apps/web/src/ui/Thread.tsx', content: 'export function Thread() {}\n' },
    ],
    chats: [
      {
        id: 'demo-thread-images',
        title: 'Add thread images to the sidebar',
        provider: 'claude-code',
        model: 'claude-opus-5-5',
        approval: 'auto',
        status: 'working',
        createdAgoMs: 6 * MINUTE,
        worktreeBranch: 'feat/thread-images',
        image: tastecodeImage,
        turns: [],
      },
      {
        id: 'demo-focus-ring',
        title: 'Soften the prompt bar focus ring',
        status: 'ready',
        unread: true,
        provider: 'claude-code',
        model: 'claude-opus-5-5',
        effort: 'high',
        approval: 'auto',
        turns: [
          {
            prompt:
              'The focus ring on the prompt bar feels too loud in dark mode. Can you soften it without losing contrast for keyboard users?',
            agoMs: 2 * HOUR,
            durationMs: 48_000,
            items: [
              {
                type: 'reasoning',
                text: 'The ring comes from `.composer:focus-within` in focus-ring.css: a 2px outline in the full accent colour. Keyboard users still need a visible ring, so I will lower its strength and add an inner hairline instead of removing it.',
              },
              toolCall(
                'Grep',
                { pattern: 'focus-within', path: 'apps/web/src/styles' },
                'apps/web/src/styles/app.css:812\napps/web/src/styles/focus-ring.css:12',
              ),
              toolCall(
                'Read',
                { file_path: 'apps/web/src/styles/focus-ring.css' },
                '.composer:focus-within {\n  outline: 2px solid var(--accent);\n  outline-offset: 2px;\n}',
              ),
              {
                type: 'file_change',
                path: 'apps/web/src/styles/focus-ring.css',
                linesAdded: 3,
                linesRemoved: 2,
                text: FOCUS_RING_DIFF,
              },
              {
                type: 'command',
                command: 'pnpm exec vitest run src/styles/focus-outline.test.ts',
                exitCode: 0,
                durationMs: 3_400,
                text: ' ✓ src/styles/focus-outline.test.ts (6 tests) 41ms\n\n Test Files  1 passed (1)\n      Tests  6 passed (6)',
              },
              assistant(
                'I softened the ring rather than removing it:\n\n- The outline now mixes the accent at **55%** instead of drawing it at full strength.\n- It sits 1px from the bar instead of 2px, so it reads as part of the control.\n- An inner hairline in `--line-strong` keeps the edge visible on dark surfaces.\n\nThe focus-outline tests still pass. Keyboard focus measures 3.4:1 against `--bg-prompt`, above the 3:1 that WCAG asks for non-text contrast.',
              ),
            ],
            diff: FOCUS_RING_DIFF,
            usage: usage(41_200, 200_000, 'claude-opus-5-5'),
          },
          {
            prompt: 'Looks better. Does the light theme still pass?',
            agoMs: 110 * 60_000,
            durationMs: 22_000,
            items: [
              {
                type: 'command',
                command: 'pnpm exec vitest run src/styles/muted-text-contrast.test.ts',
                exitCode: 0,
                durationMs: 2_900,
                text: ' ✓ src/styles/muted-text-contrast.test.ts (4 tests) 18ms\n\n Test Files  1 passed (1)\n      Tests  4 passed (4)',
              },
              assistant(
                'Yes. In the light theme the mixed accent lands at **4.1:1** against the prompt bar, and the contrast tests pass.\n\nIf you want it quieter still, `50%` is the lowest mix that keeps 3:1 in both themes.',
              ),
            ],
            usage: usage(44_900, 200_000, 'claude-opus-5-5'),
          },
          {
            prompt: 'Keep 55%. Anything else to check before I merge?',
            agoMs: 100 * 60_000,
            durationMs: 8_000,
            items: [
              assistant(
                'Nothing else. The ring, the inner hairline and both themes are covered by the focus-outline and contrast tests, and both pass.',
              ),
            ],
            usage: usage(46_100, 200_000, 'claude-opus-5-5'),
          },
        ],
      },
      {
        id: 'demo-sidebar-audit',
        title: 'Audit sidebar spacing',
        lifecycle: { state: 'settled', agoMs: 21 * HOUR },
        provider: 'codex',
        model: 'gpt-5.6-sol',
        effort: 'medium',
        approval: 'auto',
        turns: [
          {
            prompt: 'Audit the sidebar spacing against the 4px grid and list anything off.',
            agoMs: 26 * HOUR,
            durationMs: 96_000,
            plan: [
              { text: 'Measure every spacing value in the sidebar styles', status: 'done' },
              { text: 'Compare them against the 4px grid', status: 'done' },
              { text: 'Report the values that are off', status: 'done' },
            ],
            items: [
              {
                type: 'tool_call',
                text: `spawn_agent\n${JSON.stringify({
                  prompt:
                    'List every padding, margin and gap in the sidebar styles and flag the values that are not multiples of 4px.',
                  agent_type: 'explorer',
                })}`,
                subagent: {
                  id: 'demo-explorer-1',
                  name: 'Explorer',
                  description: 'Measure sidebar spacing',
                  state: 'completed',
                  toolUses: 14,
                  tokens: 23_800,
                  durationMs: 41_000,
                  summary:
                    'Found 31 spacing values in the sidebar rules. Three are off the grid: .sessrow padding (5px 10px), .rail__section-title margin (14px 6px) and .rail__footer padding-inline (10px).',
                },
              },
              assistant(
                'The sidebar is almost entirely on the 4px grid. Three values are off:\n\n| Rule | Now | On the grid |\n| --- | --- | --- |\n| `.sessrow` padding | 5px 10px | 4px 8px |\n| `.rail__section-title` margin | 14px 6px | 16px 8px |\n| `.rail__footer` padding-inline | 10px | 12px |\n\nEverything else, 28 values, already uses multiples of 4.',
              ),
            ],
            usage: usage(63_000, 272_000, 'gpt-5.6-sol'),
          },
          {
            prompt: 'Fix the three off-grid values.',
            agoMs: 25 * HOUR,
            durationMs: 31_000,
            items: [
              toolCall(
                'shell',
                { command: ['rg', '-n', 'sessrow|rail__section-title|rail__footer', 'app.css'] },
                '402:.sessrow {\n517:.rail__section-title {\n688:.rail__footer {',
              ),
              {
                type: 'file_change',
                path: 'apps/web/src/styles/app.css',
                linesAdded: 3,
                linesRemoved: 3,
                text: SIDEBAR_SPACING_DIFF,
              },
              assistant(
                'Done. The three rules now use `4px 8px`, `16px 8px` and `12px`. Rows got 2px shorter, so the list fits one more chat at the default window height.',
              ),
            ],
            diff: SIDEBAR_SPACING_DIFF,
            usage: usage(71_400, 272_000, 'gpt-5.6-sol'),
          },
        ],
      },
      {
        id: 'demo-transcript-jump',
        title: 'Why does the transcript jump on resize?',
        lifecycle: { state: 'settled', agoMs: DAY },
        provider: 'grok',
        model: 'grok-4.7',
        approval: 'full',
        turns: [
          {
            prompt:
              'When I resize the window the transcript jumps up a few lines. What causes that?',
            agoMs: 3 * DAY,
            durationMs: 19_000,
            items: [
              {
                type: 'reasoning',
                text: 'Resizing changes line wrapping, so every row above the viewport changes height. Without an anchor the scroll offset stays fixed in pixels while the content above it grows.',
              },
              assistant(
                'Rows above the viewport rewrap when the width changes, so they grow or shrink while the scroll offset stays the same number of pixels. The content under your eyes moves.\n\nAnchor the scroll to the first visible row instead:\n\n```ts\nconst anchor = firstVisibleRow(list)\nconst before = anchor.getBoundingClientRect().top\nobserver.observe(list)\n// after layout\nlist.scrollTop += anchor.getBoundingClientRect().top - before\n```\n\nThe browser can do this for you with `overflow-anchor: auto`, but it ignores virtualised rows that are not in the DOM, so the manual anchor is the reliable fix here.',
              ),
            ],
            usage: usage(18_300, 256_000, 'grok-4.7'),
          },
        ],
      },
      {
        id: 'demo-release-notes',
        title: 'Release notes for v0.5.0',
        lifecycle: { state: 'snoozed' },
        provider: 'claude-code',
        model: 'claude-sonnet-5-5',
        effort: 'medium',
        approval: 'ask',
        pinned: true,
        turns: [
          {
            prompt: 'Draft short release notes for v0.5.0 from the merged pull requests.',
            agoMs: 5 * HOUR,
            durationMs: 37_000,
            items: [
              toolCall(
                'mcp__github__search_issues',
                { query: 'is:pr is:merged milestone:v0.5.0' },
                '24 pull requests',
              ),
              assistant(
                '## TasteCode 0.5.0\n\n**New**\n- Sub-agents show live progress in the transcript.\n- A design sandbox for trying the UI in a browser with dummy data.\n\n**Better**\n- Settings open faster with many providers.\n- The prompt bar focus ring is softer in dark mode.\n\n**Fixed**\n- Large chats reconnect without reloading the whole history.\n- The sidebar keeps its scroll position after a chat finishes.',
              ),
            ],
            usage: usage(29_800, 200_000, 'claude-sonnet-5-5'),
          },
        ],
      },
    ],
  },
  {
    name: 'design-system',
    branch: 'main',
    branches: ['main', 'tokens/dark-mode'],
    pinned: false,
    createdAgoMs: 18 * DAY,
    files: [
      { path: 'README.md', content: '# design-system\n\nTokens and components. (Sandbox copy.)\n' },
      { path: 'tokens/color.json', content: '{\n  "surface": "#1a1a1a"\n}\n' },
      { path: 'tokens/radius.json', content: '{\n  "md": "8px"\n}\n' },
    ],
    chats: [
      {
        id: 'demo-token-audit',
        title: 'Dark mode token audit',
        status: 'queued',
        provider: 'codex',
        model: 'gpt-5.6-terra',
        effort: 'medium',
        approval: 'auto',
        turns: [
          {
            prompt: 'Which surface tokens are too close to each other in dark mode?',
            agoMs: 2 * DAY,
            durationMs: 28_000,
            items: [
              toolCall(
                'shell',
                { command: ['cat', 'tokens/color.json'] },
                '{ "surface": "#1a1a1a", "surface-2": "#222222", "surface-3": "#2b2b2b" }',
              ),
              assistant(
                '`surface` and `surface-2` differ by only **1.1:1**, so a card on a panel barely separates. `surface-3` is fine at 1.3:1 against `surface`.\n\nRaising `surface-2` to `#252525` gives 1.2:1 without making menus look grey.',
              ),
            ],
            usage: usage(22_100, 272_000, 'gpt-5.6-terra'),
          },
        ],
      },
      {
        id: 'demo-radius-scale',
        title: 'Radius scale proposal',
        lifecycle: { state: 'settled', agoMs: 2 * DAY },
        provider: 'claude-code',
        model: 'claude-opus-5-5',
        effort: 'high',
        approval: 'auto',
        turns: [
          {
            prompt: 'Propose a radius scale that works with 32px controls.',
            agoMs: 6 * DAY,
            durationMs: 24_000,
            items: [
              assistant(
                'A scale tuned to 32px controls:\n\n| Token | Value | Used for |\n| --- | --- | --- |\n| `--r-sm` | 5px | chips, tags |\n| `--r-md` | 8px | buttons, inputs |\n| `--r-lg` | 12px | menus, popovers |\n| `--r-card` | 16px | cards, panels |\n| `--r-2xl` | 20px | the prompt bar |\n\nKeep nested corners concentric: an inner radius is the outer one minus the padding between them.',
              ),
            ],
            usage: usage(12_400, 200_000, 'claude-opus-5-5'),
          },
        ],
      },
    ],
  },
  {
    name: 'website',
    branch: 'main',
    branches: ['main'],
    pinned: false,
    createdAgoMs: 9 * DAY,
    files: [
      { path: 'index.html', content: '<!doctype html>\n<title>Website</title>\n' },
      { path: 'styles.css', content: 'body { margin: 0; }\n' },
    ],
    chats: [
      {
        id: 'demo-hero-copy',
        title: 'Hero copy variations',
        status: 'approval',
        provider: 'grok',
        model: 'grok-4.7',
        approval: 'auto',
        unread: true,
        turns: [
          {
            prompt: 'Give me three hero headlines for the landing page. Short, no buzzwords.',
            agoMs: 40 * 60_000,
            durationMs: 11_000,
            items: [
              assistant(
                '1. **Your agents, one window.**\n2. **Code with every model you pay for.**\n3. **Ask once. Watch it work.**\n\nThe first is the clearest for someone who has never heard of the app.',
              ),
            ],
            usage: usage(6_200, 256_000, 'grok-4.7'),
          },
        ],
      },
    ],
  },
  // Three projects with no transcripts, so the inbox shows every state a
  // thread can be in: running, failed and waiting on the person.
  {
    name: 'harbor-site',
    branch: 'main',
    branches: ['main'],
    pinned: false,
    createdAgoMs: 12 * DAY,
    files: [],
    chats: [
      {
        id: 'demo-gallery-grid',
        title: 'Rebuild the gallery grid',
        provider: 'codex',
        model: 'gpt-5.6-sol',
        approval: 'auto',
        status: 'working',
        createdAgoMs: 9 * MINUTE,
        worktreeBranch: 'feat/gallery-grid',
        image: harborSiteImage,
        turns: [],
      },
      {
        id: 'demo-checkout-validation',
        title: 'Fix checkout form validation',
        provider: 'claude-code',
        model: 'claude-sonnet-5-5',
        approval: 'ask',
        status: 'failed',
        createdAgoMs: 34 * MINUTE,
        image: harborSiteImage,
        turns: [],
      },
    ],
  },
  {
    name: 'field-notes',
    branch: 'main',
    branches: ['main'],
    pinned: false,
    createdAgoMs: 4 * DAY,
    files: [],
    chats: [
      {
        id: 'demo-pricing-layout',
        title: 'Choose a pricing page layout',
        provider: 'claude-code',
        model: 'claude-opus-5-5',
        approval: 'ask',
        status: 'input',
        createdAgoMs: 18 * MINUTE,
        image: fieldNotesImage,
        turns: [],
      },
    ],
  },
  {
    name: 'ledger-api',
    branch: 'main',
    branches: ['main'],
    pinned: false,
    createdAgoMs: 2 * DAY,
    files: [],
    chats: [
      {
        id: 'demo-webhook-retries',
        title: 'Write webhook retry tests',
        provider: 'api',
        model: 'claude-sonnet-5-5',
        approval: 'auto',
        status: 'working',
        createdAgoMs: MINUTE,
        turns: [],
      },
    ],
  },
]

/** Where a chat lands in the inbox, the way the inbox files it. */
export function demoInboxGroup(chat: DemoChat): 'active' | 'snoozed' | 'settled' {
  return chat.lifecycle?.state ?? 'active'
}

// The inbox sample must add up: every chat in exactly one group, every state
// the rail draws present once in the active group, and four pictures.
{
  const chats = DEMO_PROJECTS.flatMap((project) => project.chats)
  const active = chats.filter((chat) => demoInboxGroup(chat) === 'active')
  const snoozed = chats.filter((chat) => demoInboxGroup(chat) === 'snoozed')
  const settled = chats.filter((chat) => demoInboxGroup(chat) === 'settled')
  const count = (status: ThreadInboxStatus) =>
    active.filter((chat) => chat.status === status).length
  console.assert(
    active.length + snoozed.length + settled.length === chats.length,
    'every sandbox chat is in one inbox group',
  )
  console.assert(
    chats.length === 12 && active.length === 8 && snoozed.length === 1 && settled.length === 3,
    'the inbox sample is 8 active, 1 snoozed and 3 settled chats',
  )
  console.assert(
    count('working') === 3 &&
      count('failed') === 1 &&
      count('input') + count('approval') === 2 &&
      count('queued') === 1 &&
      count('ready') === 1,
    'the active sample has 3 working, 1 failed, 2 waiting, 1 queued and 1 done',
  )
  console.assert(
    chats.filter((chat) => chat.image).length === 4,
    'four sample chats carry a picture',
  )
  console.assert(
    chats.every((chat) => chat.status !== 'working' || chat.createdAgoMs !== undefined),
    'a sample chat shown as working says when it started',
  )
}

/**
 * The dummy answer a live turn streams. It names what the sandbox is so a
 * screenshot of it can never be mistaken for a real reply.
 */
export function demoReply(prompt: string, providerName: string) {
  const quoted = prompt.trim().replace(/\s+/g, ' ')
  const shown = quoted.length > 90 ? `${quoted.slice(0, 89)}…` : quoted
  const keyword =
    quoted
      .split(/[^A-Za-z0-9_-]+/)
      .filter((word) => word.length > 3)
      .sort((a, b) => b.length - a.length)[0] ?? 'prompt'
  return {
    thinking: `The user wrote "${shown}". This is the design sandbox, so I will look around briefly and answer with placeholder text that streams like a real reply.`,
    toolArgs: { pattern: keyword, path: 'apps/web/src' },
    toolOutput: 'apps/web/src/ui/Composer.tsx:118\napps/web/src/ui/Thread.tsx:2294',
    answer: `This is a dummy answer from the design sandbox, streamed as ${providerName} would stream it. No provider ran and nothing left this browser tab.\n\nYou asked: “${shown}”\n\n- The prompt bar, sidebar and transcript are the real components.\n- This text arrives word by word through \`item.delta\` events, as in a real turn.\n- **Stop** ends the turn; a prompt sent meanwhile waits in the queue or steers it.\n\n\`\`\`ts\nconst sandbox = { provider: '${providerName}', streaming: true }\n\`\`\`\n\nEdit a stylesheet and Vite reloads it in place, so you can restyle this answer while it streams.`,
  }
}
