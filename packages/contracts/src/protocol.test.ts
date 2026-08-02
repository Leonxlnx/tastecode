import { describe, expect, it } from 'vitest'
import { DomainEventSchema, ItemSchema } from './domain.js'
import {
  channels,
  DiffFileSchema,
  ErrorCode,
  McpCapabilitiesSchema,
  McpServerConfigSchema,
  McpServerSchema,
  McpStartupStatusSchema,
  methods,
  PushSchema,
  RequestSchema,
  ResponseSchema,
  SidebarSettingsSchema,
  SkillCapabilitiesSchema,
  SkillSchema,
  ThreadLifecycleSchema,
} from './protocol.js'

describe('domain events', () => {
  it('accepts a streaming delta', () => {
    const event = {
      type: 'item.delta',
      turnId: 't1',
      itemId: 'i1',
      textDelta: 'hello',
    }
    expect(DomainEventSchema.parse(event)).toEqual(event)
  })

  it('rejects an event with an unknown type instead of passing it through', () => {
    // Silently accepting unknown events is how a client and server drift apart
    // without anyone noticing. Adapters must map to `unknown` explicitly.
    expect(() => DomainEventSchema.parse({ type: 'item.exploded' })).toThrow()
  })

  it('keeps unrecognised adapter output as an unknown item rather than dropping it', () => {
    const item = ItemSchema.parse({
      id: 'i1',
      turnId: 't1',
      type: 'unknown',
      status: 'completed',
      text: 'some shape we did not expect',
      createdAt: Date.now(),
    })
    expect(item.type).toBe('unknown')
  })

  it('accepts automatic approval review progress and results', () => {
    const review = {
      id: 'review-1',
      turnId: 'turn-1',
      status: 'approved' as const,
      description: 'Run npm test',
      rationale: 'The command only runs the local test suite.',
      riskLevel: 'low' as const,
      startedAt: 10,
      completedAt: 20,
    }

    expect(DomainEventSchema.parse({ type: 'approval.review.completed', review })).toEqual({
      type: 'approval.review.completed',
      review,
    })
  })

  it('accepts structured user-input requests', () => {
    const request = {
      id: 'brief-questions-1',
      turnId: 'turn-1',
      questions: [
        {
          id: 'palette',
          header: 'Colour',
          question: 'Do you already have a palette?',
          allowOther: true,
          secret: false,
          options: [
            { label: 'Decide for me', description: 'Choose from the inferred direction.' },
            { label: 'I have colours', description: 'Add the colours as a custom answer.' },
          ],
        },
      ],
      autoResolutionMs: null,
      createdAt: 10,
    }

    expect(DomainEventSchema.parse({ type: 'user_input.requested', request })).toEqual({
      type: 'user_input.requested',
      request,
    })
    expect(DomainEventSchema.parse({ type: 'user_input.resolved', id: request.id })).toEqual({
      type: 'user_input.resolved',
      id: request.id,
    })
  })
})

describe('protocol envelopes', () => {
  it('validates a request envelope', () => {
    expect(RequestSchema.parse({ id: '1', method: 'system.info', params: {} })).toBeTruthy()
  })

  it('requires a sequence on every push so clients can detect gaps', () => {
    expect(() => PushSchema.parse({ channel: 'server.welcome', data: {} })).toThrow()
  })

  it('validates params for every declared method', () => {
    expect(
      methods['thread.start'].params.parse({
        provider: 'codex',
        workspacePath: 'D:\\x',
        serviceTier: 'priority',
        approval: 'auto-review',
      }),
    ).toBeTruthy()
    expect(
      methods['thread.sendTurn'].params.parse({
        threadId: 'th1',
        text: 'hello',
        model: 'gpt-5.6-sol',
        effort: 'xhigh',
        serviceTier: 'priority',
      }),
    ).toBeTruthy()
    expect(
      methods['thread.sendTurn'].result.parse({
        queued: true,
        queuedTurn: {
          id: 'queued-1',
          text: 'Do this next',
          attachments: ['D:\\x\\reference.png'],
          createdAt: 10,
        },
      }),
    ).toBeTruthy()
    expect(methods['thread.queue'].result.parse({ items: [], canSteer: true })).toEqual({
      items: [],
      canSteer: true,
    })
    expect(
      methods['thread.respondToUserInput'].params.parse({
        threadId: 'th1',
        requestId: 'brief-questions-1',
        answers: { palette: ['Decide for me'] },
      }),
    ).toEqual({
      threadId: 'th1',
      requestId: 'brief-questions-1',
      answers: { palette: ['Decide for me'] },
    })
    expect(() =>
      methods['thread.respondToUserInput'].params.parse({
        threadId: 'th1',
        requestId: 'brief-questions-1',
        answers: { palette: [] },
      }),
    ).toThrow()
    expect(() => methods['thread.start'].params.parse({ provider: 'nope' })).toThrow()
    const { undo } = methods['thread.restore'].result.parse({ undo: 'restore-token' })
    expect(methods['thread.undoRestore'].params.parse({ threadId: 'th1', undo })).toEqual({
      threadId: 'th1',
      undo,
    })
    expect(() => methods['thread.restore'].result.parse({ undo: '' })).toThrow()
    const projects = methods['projects.list'].result.parse({
      projects: [
        {
          path: 'D:\\x',
          name: 'x',
          pinned: false,
          createdAt: 0,
          sessions: [
            {
              id: 'th1',
              title: 'Isolated',
              provider: 'codex',
              createdAt: 0,
              running: true,
              worktreeBranch: 'harness/th1',
            },
          ],
        },
      ],
    })
    expect(projects.projects[0]?.sessions[0]?.worktreeBranch).toBe('harness/th1')
    expect(
      methods['workspace.switchBranch'].params.parse({ path: 'D:\\x', branch: 'feature/shelf' }),
    ).toEqual({ path: 'D:\\x', branch: 'feature/shelf' })
  })

  it('reports every panic-stop target as interrupted or failed', () => {
    const result = methods['system.panicStop'].result.parse({
      sessions: [
        { threadId: 'thread-1', status: 'interrupted' },
        { threadId: 'thread-2', status: 'failed', error: 'Adapter did not respond' },
      ],
    })

    expect(result.sessions).toHaveLength(2)
    expect(() =>
      methods['system.panicStop'].result.parse({
        sessions: [{ threadId: 'thread-2', status: 'failed' }],
      }),
    ).toThrow()
  })

  it('defines a platform-neutral terminal stream', () => {
    const opened = methods['terminal.open'].params.parse({
      threadId: 'thread-1',
      columns: 120,
      rows: 40,
    })
    expect(opened).toEqual({ threadId: 'thread-1', columns: 120, rows: 40 })

    const { terminalId } = methods['terminal.open'].result.parse({ terminalId: 'terminal-1' })
    expect(methods['terminal.input'].params.parse({ terminalId, data: '\u0003' })).toEqual({
      terminalId,
      data: '\u0003',
    })
    expect(methods['terminal.resize'].params.parse({ terminalId, columns: 80, rows: 24 })).toEqual({
      terminalId,
      columns: 80,
      rows: 24,
    })
    expect(methods['terminal.close'].params.parse({ terminalId })).toEqual({ terminalId })

    expect(channels['terminal.output'].parse({ terminalId, data: 'ready\r\n' })).toEqual({
      terminalId,
      data: 'ready\r\n',
    })
    expect(channels['terminal.exit'].parse({ terminalId, exitCode: 0 })).toEqual({
      terminalId,
      exitCode: 0,
    })
    expect(channels['terminal.exit'].parse({ terminalId, exitCode: null }).exitCode).toBeNull()
    expect(() =>
      methods['terminal.resize'].params.parse({ terminalId, columns: 0, rows: 24 }),
    ).toThrow()
  })

  it('keeps unreported usage cost absent', () => {
    const result = methods['usage.summary'].result.parse({
      session: {
        inputTokens: 10,
        cachedInputTokens: 2,
        outputTokens: 3,
        reasoningTokens: 1,
        totalTokens: 16,
      },
      today: {
        inputTokens: 10,
        cachedInputTokens: 2,
        outputTokens: 3,
        reasoningTokens: 1,
        totalTokens: 16,
        costUsd: 0.04,
      },
      limits: [{ label: '5 hours', usedPercent: 25, resetsAt: 1_800_000 }],
    })

    expect(result.session.costUsd).toBeUndefined()
    expect(result.today.costUsd).toBe(0.04)
    expect(result.limits[0]?.usedPercent).toBe(25)
  })

  it('validates versioned diff review and stale snapshot errors', () => {
    const diff = {
      threadId: 'thread-1',
      version: 'snapshot-1',
      files: [
        {
          path: 'src/index.ts',
          status: 'modified' as const,
          binary: false,
          hunks: [
            {
              id: 'hunk-1',
              header: '@@ -1 +1 @@',
              oldStart: 1,
              oldLines: 1,
              newStart: 1,
              newLines: 1,
              lines: [
                { kind: 'deletion' as const, oldLine: 1, text: 'old', noNewlineAtEnd: true },
                { kind: 'addition' as const, newLine: 1, text: 'new' },
              ],
            },
          ],
        },
        {
          path: 'assets/new-logo.png',
          previousPath: 'assets/logo.png',
          status: 'renamed' as const,
          binary: true,
          hunks: [],
        },
      ],
    }

    expect(methods['thread.diff'].result.parse(diff)).toEqual(diff)
    expect(
      methods['thread.reviewHunk'].params.parse({
        threadId: 'thread-1',
        version: 'snapshot-1',
        path: 'src/index.ts',
        hunkId: 'hunk-1',
        decision: 'reject',
      }).decision,
    ).toBe('reject')
    expect(
      methods['thread.reviewFile'].params.parse({
        threadId: 'thread-1',
        version: 'snapshot-1',
        path: 'assets/new-logo.png',
        decision: 'accept',
      }).decision,
    ).toBe('accept')
    expect(() =>
      DiffFileSchema.parse({
        path: 'asset.bin',
        status: 'added',
        binary: true,
        hunks: diff.files[0]?.hunks,
      }),
    ).toThrow()
    expect(() =>
      DiffFileSchema.parse({ path: 'new.ts', status: 'renamed', binary: false, hunks: [] }),
    ).toThrow()
    expect(() =>
      DiffFileSchema.parse({
        path: 'new.ts',
        previousPath: 'old.ts',
        status: 'modified',
        binary: false,
        hunks: [],
      }),
    ).toThrow()
    expect(
      ResponseSchema.parse({
        id: 'request-1',
        error: { code: ErrorCode.STALE_SNAPSHOT, message: 'Refresh the diff and try again.' },
      }),
    ).toMatchObject({ error: { code: 'stale_snapshot' } })
    expect(() =>
      ResponseSchema.parse({ id: 'request-2', error: { code: 'typo', message: 'Nope' } }),
    ).toThrow()
  })

  it('validates paginated cross-session search', () => {
    expect(
      methods['search.sessions'].params.parse({
        query: ' regression ',
        projectPath: 'D:\\project',
        provider: 'codex',
        cursor: 'current-page',
        limit: 25,
      }),
    ).toEqual({
      query: 'regression',
      projectPath: 'D:\\project',
      provider: 'codex',
      cursor: 'current-page',
      limit: 25,
    })
    expect(
      methods['search.sessions'].result.parse({
        results: [
          {
            projectPath: 'D:\\project',
            projectName: 'project',
            threadId: 'thread-1',
            threadTitle: 'Find the regression',
            turnId: 'turn-2',
            provider: 'codex',
            createdAt: 42,
            snippet: [
              { text: 'The ', highlighted: false },
              { text: 'regression', highlighted: true },
              { text: ' started here.', highlighted: false },
            ],
          },
        ],
        nextCursor: 'next-page',
      }).nextCursor,
    ).toBe('next-page')
    expect(() => methods['search.sessions'].result.parse({ results: [], nextCursor: '' })).toThrow()
    expect(() => methods['search.sessions'].params.parse({ query: '   ' })).toThrow()
    expect(() =>
      methods['search.sessions'].params.parse({ query: 'regression', limit: 101 }),
    ).toThrow()
  })

  it('validates the persisted inbox lifecycle without conflating archive state', () => {
    const settled = methods['thread.settle'].result.parse({
      lifecycle: { state: 'settled', settledAt: 20, reason: 'manual' },
    })
    expect(settled.lifecycle.state).toBe('settled')
    expect(methods['thread.snooze'].params.parse({ threadId: 'thread-1', wakeAt: 60_000 })).toEqual(
      { threadId: 'thread-1', wakeAt: 60_000 },
    )
    expect(ThreadLifecycleSchema.parse({ state: 'active', keepActive: true, wokeAt: 30 })).toEqual({
      state: 'active',
      keepActive: true,
      wokeAt: 30,
    })
    expect(SidebarSettingsSchema.parse({ mode: 'inbox', autoSettleDays: null })).toEqual({
      mode: 'inbox',
      autoSettleDays: null,
    })
    expect(() =>
      ThreadLifecycleSchema.parse({ state: 'snoozed', snoozedAt: 20, wakeAt: -1 }),
    ).toThrow()
    expect(() => SidebarSettingsSchema.parse({ mode: 'inbox', autoSettleDays: 91 })).toThrow()
  })

  it('validates provider-neutral MCP inventory', () => {
    const servers = McpServerSchema.array().parse([
      {
        id: 'local-files',
        displayName: 'Local files',
        scope: 'project',
        enabled: true,
        transport: {
          type: 'stdio',
          command: 'node',
          args: ['server.js'],
          environment: {
            API_TOKEN: { source: 'credential', credentialRef: 'mcp/local-files/token' },
          },
        },
        auth: { status: 'not_required' },
        startup: { state: 'ready' },
        tools: [
          {
            name: 'read_file',
            inputSchema: {
              type: 'object',
              properties: { path: { type: 'string' } },
              required: ['path'],
            },
          },
        ],
        resources: [{ uri: 'project://readme', name: 'README', mimeType: 'text/markdown' }],
        resourceTemplates: [
          {
            uriTemplate: 'project://files/{path}',
            name: 'Project file',
            mimeType: 'text/plain',
          },
        ],
      },
      {
        id: 'github',
        scope: 'global',
        enabled: true,
        auth: { status: 'sign_in_required', method: 'oauth' },
        startup: { state: 'stopped' },
        tools: [],
        resources: [],
        resourceTemplates: [],
      },
    ])

    expect(servers[0]?.scope).toBe('project')
    expect(servers[1]?.transport).toBeUndefined()
    expect(
      McpCapabilitiesSchema.parse({
        inventory: true,
        add: true,
        update: true,
        remove: true,
        reload: true,
        startOAuth: true,
        cancelOAuth: false,
      }).cancelOAuth,
    ).toBe(false)
    expect(
      McpServerConfigSchema.parse({
        id: 'remote-docs',
        enabled: true,
        transport: {
          type: 'http',
          url: 'https://mcp.example.test',
          headers: {
            Authorization: {
              source: 'credential',
              credentialRef: 'mcp/remote-docs/authorization',
            },
          },
        },
      }).id,
    ).toBe('remote-docs')
    expect(McpServerConfigSchema.parse({ id: 'github', enabled: false })).toEqual({
      id: 'github',
      enabled: false,
    })
    expect(() => McpServerConfigSchema.parse({ id: 'missing-transport', enabled: true })).toThrow()
    expect(() =>
      McpServerConfigSchema.parse({
        id: 'bad-url',
        enabled: true,
        transport: { type: 'http', url: 'ftp://example.test' },
      }),
    ).toThrow()
    expect(() => McpStartupStatusSchema.parse({ state: 'failed', message: '' })).toThrow()
  })

  it('validates project-scoped MCP management methods', () => {
    expect(
      methods['mcp.list'].params.parse({ provider: 'codex', projectPath: 'D:\\project' }),
    ).toEqual({ provider: 'codex', projectPath: 'D:\\project' })
    expect(
      methods['mcp.add'].params.parse({
        provider: 'codex',
        projectPath: 'D:\\project',
        server: { id: 'github', enabled: false },
      }).server,
    ).toEqual({ id: 'github', enabled: false })
    expect(
      methods['mcp.update'].params.parse({
        provider: 'codex',
        projectPath: 'D:\\project',
        server: {
          id: 'remote-docs',
          enabled: true,
          transport: { type: 'http', url: 'https://mcp.example.test' },
        },
      }).server.id,
    ).toBe('remote-docs')
    expect(
      methods['mcp.remove'].params.parse({
        provider: 'codex',
        projectPath: 'D:\\project',
        serverId: 'remote-docs',
      }).serverId,
    ).toBe('remote-docs')
    expect(
      methods['mcp.reload'].params.parse({ provider: 'codex', projectPath: 'D:\\project' }),
    ).toBeTruthy()

    const login = methods['mcp.startOAuth'].result.parse({
      loginId: 'mcp-login-1',
      authUrl: 'https://auth.example.test/authorize',
    })
    expect(
      methods['mcp.cancelOAuth'].params.parse({
        provider: 'codex',
        projectPath: 'D:\\project',
        serverId: 'github',
        loginId: login.loginId,
      }).loginId,
    ).toBe('mcp-login-1')
    expect(
      channels['mcp.oauth'].parse({
        provider: 'codex',
        projectPath: 'D:\\project',
        serverId: 'github',
        loginId: login.loginId,
        success: true,
        error: null,
      }).success,
    ).toBe(true)
    expect(() =>
      methods['mcp.startOAuth'].result.parse({
        loginId: 'mcp-login-2',
        authUrl: 'file:///tmp/token',
      }),
    ).toThrow()
  })

  it('validates provider-neutral Agent Skills inventory and mutations', () => {
    const skill = SkillSchema.parse({
      id: 'project-design',
      name: 'design-taste',
      displayName: 'Design taste',
      description: 'Review interface decisions.',
      source: { type: 'folder', path: 'D:\\project\\.agents\\skills\\design-taste' },
      scope: 'project',
      enabled: true,
      dependencyErrors: [{ dependency: 'figma', message: 'The Figma connector is not installed.' }],
      vendorExtension: 'must not cross the contract',
    })

    expect(skill.source.type).toBe('folder')
    expect('vendorExtension' in skill).toBe(false)
    expect(
      SkillCapabilitiesSchema.parse({ inventory: true, configure: true, install: false }),
    ).toEqual({ inventory: true, configure: true, install: false })

    expect(
      methods['skills.list'].params.parse({
        provider: 'codex',
        projectPath: 'D:\\project',
      }),
    ).toEqual({ provider: 'codex', projectPath: 'D:\\project' })
    expect(
      methods['skills.list'].result.parse({
        capabilities: { inventory: true, configure: true, install: true },
        skills: [skill],
        errors: [{ path: 'D:\\broken\\SKILL.md', message: 'Missing frontmatter.' }],
      }).skills[0]?.name,
    ).toBe('design-taste')
    expect(
      methods['skills.setEnabled'].params.parse({
        provider: 'codex',
        projectPath: 'D:\\project',
        skillId: skill.id,
        enabled: false,
      }).enabled,
    ).toBe(false)
    expect(
      methods['skills.installFromFolder'].params.parse({
        provider: 'codex',
        projectPath: 'D:\\project',
        folderPath: 'D:\\downloads\\my-skill',
      }).folderPath,
    ).toBe('D:\\downloads\\my-skill')
    expect(
      channels['skills.changed'].parse({ provider: 'codex', projectPath: 'D:\\project' }),
    ).toEqual({ provider: 'codex', projectPath: 'D:\\project' })

    expect(() => SkillSchema.parse({ ...skill, source: { type: 'folder', path: '' } })).toThrow()
    expect(() =>
      methods['skills.setEnabled'].params.parse({
        provider: 'codex',
        projectPath: 'D:\\project',
        skillId: '',
        enabled: true,
      }),
    ).toThrow()
  })

  it('bounds normalized voice clips at the protocol boundary', () => {
    const valid = {
      requestId: '0dca4330-66f5-4f68-9287-c6b2bf4c6bf0',
      provider: 'codex' as const,
      audioBase64: 'UklGRg==',
      mimeType: 'audio/wav' as const,
      sampleRateHz: 24_000 as const,
      durationMs: 1_000,
    }

    expect(methods['voice.transcribe'].params.parse(valid)).toEqual(valid)
    expect(() =>
      methods['voice.transcribe'].params.parse({ ...valid, durationMs: 120_001 }),
    ).toThrow()
    expect(() =>
      methods['voice.transcribe'].params.parse({ ...valid, mimeType: 'audio/webm' }),
    ).toThrow()
    expect(() =>
      methods['voice.transcribe'].params.parse({ ...valid, audioBase64: 'not base64!' }),
    ).toThrow()
  })

  it('validates data for every declared channel', () => {
    expect(
      channels['thread.event'].parse({
        threadId: 'th1',
        event: { type: 'turn.completed', turnId: 't1', status: 'completed' },
      }),
    ).toBeTruthy()
    expect(
      channels['thread.queue'].parse({
        threadId: 'th1',
        items: [
          {
            id: 'queued-1',
            text: 'Do this next',
            attachments: [],
            createdAt: 10,
          },
        ],
        canSteer: false,
      }),
    ).toBeTruthy()
  })
})
