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
  PreviewCaptureRequestSchema,
  PreviewCaptureResultSchema,
  PushSchema,
  RequestSchema,
  ResponseSchema,
  SidebarSettingsSchema,
  SkillCapabilitiesSchema,
  SkillSchema,
  ThreadLifecycleSchema,
  UsageHistoryResultSchema,
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

  it('carries a durable turn completion boundary without rejecting legacy history', () => {
    const completed = {
      type: 'turn.completed',
      turnId: 't1',
      status: 'completed',
      completedAt: 32_000,
    }

    expect(DomainEventSchema.parse(completed)).toEqual(completed)
    expect(
      DomainEventSchema.parse({ type: 'turn.completed', turnId: 'legacy', status: 'completed' }),
    ).toEqual({ type: 'turn.completed', turnId: 'legacy', status: 'completed' })
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

  it('preserves assistant phases without rejecting legacy items', () => {
    const legacy = {
      id: 'i1',
      turnId: 't1',
      type: 'message',
      status: 'completed',
      role: 'assistant',
      text: 'Done.',
      createdAt: 1,
    }

    expect(ItemSchema.parse(legacy)).toEqual(legacy)
    expect(ItemSchema.parse({ ...legacy, phase: 'commentary' }).phase).toBe('commentary')
    expect(ItemSchema.parse({ ...legacy, phase: 'final_answer' }).phase).toBe('final_answer')
    expect(() => ItemSchema.parse({ ...legacy, phase: 'analysis' })).toThrow()
  })

  it('carries one item ID through a complete lifecycle', () => {
    const item = {
      id: 'assistant-1',
      turnId: 't1',
      type: 'message',
      status: 'started',
      role: 'assistant',
      createdAt: 1,
    }
    const events = [
      DomainEventSchema.parse({ type: 'item.started', item }),
      DomainEventSchema.parse({
        type: 'item.delta',
        turnId: item.turnId,
        itemId: item.id,
        textDelta: 'Done.',
      }),
      DomainEventSchema.parse({
        type: 'item.completed',
        item: { ...item, status: 'completed', text: 'Done.' },
      }),
    ]

    expect(events.map((event) => ('item' in event ? event.item.id : event.itemId))).toEqual([
      item.id,
      item.id,
      item.id,
    ])
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

  it('keeps usage estimates paired with their pricing coverage', () => {
    const totals = {
      uncachedInputTokens: 100,
      cachedInputTokens: 200,
      cacheWriteInputTokens: 10,
      outputTokens: 20,
      reasoningTokens: 5,
      processedTokens: 330,
      estimatedCostUsd: 0.01,
      cacheSavingsUsd: 0.02,
      providerReportedCostUsd: 0,
      providerReportedTokens: 0,
      pricedTokens: 300,
      unpricedTokens: 30,
    }
    const result = {
      range: '30d' as const,
      startDate: '2026-07-10',
      endDate: '2026-08-08',
      generatedAt: 1,
      sessionCount: 1,
      activeDays: 1,
      totals,
      providers: [{ provider: 'codex' as const, sessionCount: 1, totals }],
      models: [
        {
          provider: 'codex' as const,
          model: 'gpt-5.6-sol',
          sessionCount: 1,
          pricing: 'exact' as const,
          totals,
        },
      ],
      daily: [
        {
          date: '2026-08-08',
          sessionCount: 1,
          totals,
          providers: [{ provider: 'codex' as const, tokens: 330, estimatedCostUsd: 0.01 }],
        },
      ],
      sources: [{ provider: 'codex' as const, available: true, sessionCount: 1 }],
      scan: { status: 'idle' as const, filesProcessed: 1, filesTotal: 1 },
      warnings: [],
    }

    expect(UsageHistoryResultSchema.parse(result)).toEqual(result)
  })

  it('requires a sequence on every push so clients can detect gaps', () => {
    expect(() => PushSchema.parse({ channel: 'server.welcome', data: {} })).toThrow()
  })

  it('bounds desktop preview capture at the protocol boundary', () => {
    const request = {
      requestId: '0dca4330-66f5-4f68-9287-c6b2bf4c6bf0',
      url: 'http://127.0.0.1:5183/',
      viewports: [{ width: 1_440, height: 900 }],
    }

    expect(PreviewCaptureRequestSchema.parse(request)).toEqual(request)
    expect(() =>
      PreviewCaptureRequestSchema.parse({ ...request, url: 'https://example.com' }),
    ).toThrow()
    expect(() =>
      PreviewCaptureRequestSchema.parse({
        ...request,
        viewports: [{ width: 10_000, height: 900 }],
      }),
    ).toThrow()
    expect(
      PreviewCaptureResultSchema.parse({
        status: 'completed',
        requestId: request.requestId,
        screenshots: [{ path: 'C:\\tmp\\desktop.png', width: 1_440, height: 900 }],
      }).status,
    ).toBe('completed')
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
    expect(
      methods['thread.setApproval'].params.parse({ threadId: 'th1', approval: 'full' }),
    ).toEqual({ threadId: 'th1', approval: 'full' })
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
    expect(methods['models.list'].params.parse({ provider: 'acp', agent: 'kimi' })).toEqual({
      provider: 'acp',
      agent: 'kimi',
    })
    expect(() => methods['models.list'].params.parse({ provider: 'acp', agent: '' })).toThrow()
    expect(methods['auth.status'].params.parse({ provider: 'acp', agent: 'kimi' })).toEqual({
      provider: 'acp',
      agent: 'kimi',
    })
    expect(methods['auth.startLogin'].result.parse({ loginId: 'cli-login' })).toEqual({
      loginId: 'cli-login',
    })
    expect(() => methods['auth.status'].params.parse({ provider: 'acp', agent: '' })).toThrow()
    expect(() => methods['auth.startLogin'].result.parse({ loginId: '' })).toThrow()
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
              pinned: true,
              worktreeBranch: 'harness/th1',
            },
          ],
        },
      ],
    })
    expect(projects.projects[0]?.sessions[0]?.worktreeBranch).toBe('harness/th1')
    expect(projects.projects[0]?.sessions[0]?.pinned).toBe(true)
    const directory = methods['projects.browse'].result.parse({
      path: '/Users/me',
      name: 'me',
      entries: [
        {
          path: '/Users/me/Developer',
          name: 'Developer',
          kind: 'directory',
          modifiedAt: 1_000,
        },
      ],
    })
    expect(directory.entries[0]?.kind).toBe('directory')
    expect(methods['projects.browse'].params.parse({})).toEqual({})
    expect(() => methods['projects.browse'].params.parse({ path: '' })).toThrow()
    expect(methods['thread.pin'].params.parse({ threadId: 'th1', pinned: true })).toEqual({
      threadId: 'th1',
      pinned: true,
    })
    expect(
      methods['workspace.switchBranch'].params.parse({ path: 'D:\\x', branch: 'feature/shelf' }),
    ).toEqual({ path: 'D:\\x', branch: 'feature/shelf' })
  })

  it('keeps durable device credentials out of pairing offers', () => {
    const offer = methods['connections.startPairing'].result.parse({
      enabled: true,
      serverName: 'Studio Mac',
      port: 4312,
      addresses: [
        {
          kind: 'tailscale',
          label: 'Tailscale 100.101.22.33',
          url: 'ws://100.101.22.33:4312',
        },
      ],
      devices: [],
      webUrls: ['http://100.101.22.33:4312/#access_token=stable-web-token'],
      pairingUri: 'harness://pair?payload=short-lived-ticket',
      expiresAt: Date.now() + 300_000,
    })

    expect(offer.pairingUri).toContain('harness://pair')
    expect('deviceToken' in offer).toBe(false)
    expect(() => methods['connections.claim'].params.parse({ name: '' })).toThrow()
    expect(
      ResponseSchema.parse({
        id: 'device-request',
        error: { code: ErrorCode.FORBIDDEN, message: 'This device cannot perform that action' },
      }),
    ).toMatchObject({ error: { code: 'forbidden' } })
  })

  it('only exposes the web-app URLs on the admin status surface', () => {
    const status = methods['connections.status'].result.parse({
      enabled: true,
      serverName: 'Studio Mac',
      port: 4312,
      addresses: [{ kind: 'lan', label: 'en0 192.168.1.44', url: 'ws://192.168.1.44:4312' }],
      devices: [],
      webUrls: ['http://192.168.1.44:4312/#access_token=stable-web-token'],
    })
    expect(status.webUrls[0]).toBe('http://192.168.1.44:4312/#access_token=stable-web-token')

    // The device-facing shape deliberately carries no app URLs: a paired
    // device must not learn the long-lived web token.
    expect(
      methods['connections.deviceStatus'].result.parse({
        serverName: 'Studio Mac',
        addresses: [{ kind: 'lan', label: 'en0 192.168.1.44', url: 'ws://192.168.1.44:4312' }],
      }),
    ).toEqual({
      serverName: 'Studio Mac',
      addresses: [{ kind: 'lan', label: 'en0 192.168.1.44', url: 'ws://192.168.1.44:4312' }],
    })
  })

  it('validates remote attachment materialization requests', () => {
    expect(
      methods['attachments.saveFile'].params.parse({
        name: 'reference.pdf',
        mimeType: 'application/pdf',
        data: 'cGRm',
      }),
    ).toEqual({ name: 'reference.pdf', mimeType: 'application/pdf', data: 'cGRm' })
    expect(() =>
      methods['attachments.saveFile'].params.parse({
        name: '',
        mimeType: 'application/pdf',
        data: 'cGRm',
      }),
    ).toThrow()
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
    expect(methods['usage.summary'].params.parse({ provider: 'codex' })).toEqual({
      provider: 'codex',
    })
    expect(() => methods['usage.summary'].params.parse({})).toThrow()

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
    expect(
      channels['mcp.changed'].parse({ provider: 'codex', projectPath: 'D:\\project' }),
    ).toEqual({ provider: 'codex', projectPath: 'D:\\project' })
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

  it('carries actionable provider setup metadata', () => {
    const setup = {
      installUrl: 'https://example.test/install',
      installCommand: 'npm install -g example-cli',
      login: 'provider' as const,
    }

    expect(
      methods['providers.list'].result.parse({
        providers: [
          {
            id: 'opencode',
            displayName: 'OpenCode',
            installed: false,
            auth: 'unknown',
            setup,
          },
        ],
      }).providers[0]?.setup,
    ).toEqual(setup)
    expect(
      methods['acp.agents'].result.parse({
        agents: [
          {
            id: 'gemini',
            name: 'Gemini CLI',
            installed: false,
            verified: true,
            setup,
          },
        ],
      }).agents[0]?.setup,
    ).toEqual(setup)
    // A vendor breaking a login path is the agent's story to tell; the field
    // is optional so healthy agents carry nothing.
    expect(
      methods['acp.agents'].result.parse({
        agents: [
          {
            id: 'gemini',
            name: 'Gemini CLI',
            installed: true,
            verified: true,
            setup,
            problem: 'Google ended individual sign-in.',
          },
        ],
      }).agents[0]?.problem,
    ).toBe('Google ended individual sign-in.')
  })

  it('names an install target without carrying any command text', () => {
    const valid = { provider: 'acp', agent: 'gemini', columns: 80, rows: 24 }
    expect(methods['providers.install'].params.parse(valid)).toEqual(valid)
    expect(
      methods['providers.install'].params.parse({ provider: 'opencode', columns: 80, rows: 24 }),
    ).toEqual({ provider: 'opencode', columns: 80, rows: 24 })
    expect(methods['providers.install'].params.parse({ ...valid, command: 'rm -rf /' })).toEqual(
      valid,
    )
    expect(() =>
      methods['providers.install'].params.parse({ provider: 'acp', agent: '' }),
    ).toThrow()
    expect(methods['providers.install'].result.parse({ terminalId: 'term-1' })).toEqual({
      terminalId: 'term-1',
    })
  })

  it('names a launch target without carrying any command text', () => {
    const valid = { provider: 'acp', agent: 'gemini', columns: 80, rows: 24 }
    expect(methods['providers.launch'].params.parse(valid)).toEqual(valid)
    expect(
      methods['providers.launch'].params.parse({ provider: 'opencode', columns: 80, rows: 24 }),
    ).toEqual({ provider: 'opencode', columns: 80, rows: 24 })
    expect(methods['providers.launch'].params.parse({ ...valid, command: 'rm -rf /' })).toEqual(
      valid,
    )
    expect(() => methods['providers.launch'].params.parse({ provider: 'acp', agent: '' })).toThrow()
    expect(methods['providers.launch'].result.parse({ terminalId: 'term-1' })).toEqual({
      terminalId: 'term-1',
    })
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
