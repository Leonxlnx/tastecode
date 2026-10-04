import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { query } from '@anthropic-ai/claude-agent-sdk'
import { spawnCli } from '@harness/proc'
import { ClaudeCodeAdapter } from '../dist/adapter.js'

// Both MCP and model endpoints are local fixtures. No real account or user config is used.
const directory = await mkdtemp(path.join(tmpdir(), 'tastecode-claude-mcp-'))
const marker = path.join(directory, 'stdio-proof.json')
const canary = `fixture-${randomUUID()}`
const httpCanary = `http-fixture-${randomUUID()}`
const stdioLiteral = `stdio-mode-${randomUUID()}`
const httpLiteral = `http-mode-${randomUUID()}`
const scopedValues = [canary, httpCanary, stdioLiteral, httpLiteral]
const hash = (value) => createHash('sha256').update(value).digest('hex')
const modelKey = `model-fixture-${randomUUID()}`
const expectedHash = hash(canary)
const fixture = path.join(directory, 'mcp-fixture.mjs')
let authenticatedRequests = 0
let runtime
let spawnCount = 0
let modelRequests = 0
let resumed = false
let resumedHistoryObserved = false
const processes = []
const fixturePids = new Set()
const logs = []
const methods = new Set()
const bootstrapUrls = new Set()
const responseFor = (message) => {
  methods.add(message.method)
  if (message.method === 'initialize')
    return {
      protocolVersion: '2025-03-26',
      capabilities: { tools: {} },
      serverInfo: { name: 'local-proof', version: '1.0.0' },
    }
  if (message.method === 'tools/list')
    return {
      tools: [
        {
          name: 'ping',
          description: 'Return a fixture result',
          inputSchema: { type: 'object', properties: {} },
        },
      ],
    }
  if (message.method === 'tools/call')
    return { content: [{ type: 'text', text: 'local-proof-ok' }] }
  return {}
}
const server = createServer(async (request, response) => {
  if (request.method !== 'POST') {
    response.writeHead(405).end()
    return
  }
  const chunks = []
  let bytes = 0
  for await (const chunk of request) {
    bytes += chunk.length
    if (bytes > 2 * 1024 * 1024) {
      response.writeHead(413).end()
      return
    }
    chunks.push(chunk)
  }
  const message = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (request.url.startsWith('/v1/messages')) {
    if (request.headers['x-api-key'] !== modelKey) {
      response.writeHead(401).end()
      return
    }
    if (request.url.includes('count_tokens')) {
      response
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ input_tokens: 10 }))
      return
    }
    modelRequests += 1
    if (
      resumed &&
      message.messages?.some(
        (entry) =>
          entry.role === 'assistant' &&
          JSON.stringify(entry.content).includes('LOCAL_MODEL_FIXTURE_OK'),
      )
    )
      resumedHistoryObserved = true
    const answer = {
      id: `msg_fixture_${modelRequests}`,
      type: 'message',
      role: 'assistant',
      model: message.model,
      content: [{ type: 'text', text: 'LOCAL_MODEL_FIXTURE_OK' }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 5 },
    }
    if (!message.stream) {
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(answer))
      return
    }
    const events = [
      {
        type: 'message_start',
        message: {
          ...answer,
          content: [],
          stop_reason: null,
          usage: { input_tokens: 10, output_tokens: 0 },
        },
      },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'LOCAL_MODEL_FIXTURE_OK' },
      },
      { type: 'content_block_stop', index: 0 },
      {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { input_tokens: 10, output_tokens: 5 },
      },
      { type: 'message_stop' },
    ]
    response
      .writeHead(200, { 'content-type': 'text/event-stream' })
      .end(
        events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''),
      )
    return
  }
  if (
    request.url !== '/mcp' ||
    request.headers.authorization !== httpCanary ||
    request.headers['x-fixture-mode'] !== httpLiteral
  ) {
    response.writeHead(401).end()
    return
  }
  authenticatedRequests += 1
  if (!Object.hasOwn(message, 'id')) {
    response.writeHead(202).end()
    return
  }
  response
    .writeHead(200, { 'content-type': 'application/json' })
    .end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: responseFor(message) }))
})
let adapter
async function completeTurn(adapter, threadId) {
  let cleanup = () => {}
  const outcome = new Promise((resolve, reject) => {
    let reply = ''
    const timer = setTimeout(() => finish(new Error('Local model fixture timed out')), 15_000)
    const finish = (error) => {
      cleanup()
      if (error) reject(error)
      else resolve(reply)
    }
    const receive = (event) => {
      if (event.type === 'item.delta') reply += event.textDelta ?? ''
      if (event.type === 'thread.error') finish(new Error(event.message))
      if (event.type === 'turn.completed')
        finish(
          event.status === 'completed' ? undefined : new Error('Local model fixture turn failed'),
        )
    }
    cleanup = () => {
      clearTimeout(timer)
      adapter.off('event', receive)
    }
    adapter.on('event', receive)
  })
  try {
    const [, reply] = await Promise.all([
      adapter.sendTurn(threadId, 'Return the local fixture response.'),
      outcome,
    ])
    assert.equal(reply, 'LOCAL_MODEL_FIXTURE_OK')
  } finally {
    cleanup()
  }
}

async function readyMcp() {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    let timer
    let statuses
    try {
      statuses = await Promise.race([
        runtime.mcpServerStatus(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('MCP status timed out')), 3000)
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
    if (
      ['local', 'remote', 'sibling'].every(
        (name) => statuses.find((server) => server.name === name)?.status === 'connected',
      )
    )
      return statuses
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('Fixture MCP servers did not connect')
}

async function collectFixturePids() {
  for (const file of [marker, path.join(directory, 'sibling.json')]) {
    const proof = JSON.parse(await readFile(file, 'utf8'))
    assert(Number.isInteger(proof.pid) && proof.pid > 0)
    fixturePids.add(proof.pid)
    if (file === marker) {
      assert.equal(proof.hash, expectedHash, 'stdio credential was not scoped to its server')
      assert(
        proof.envHashes.includes(hash(stdioLiteral)),
        'stdio literal was not scoped to its server',
      )
      assert(
        !proof.envHashes.includes(hash(httpCanary)),
        'HTTP credential leaked to configured stdio sibling',
      )
      assert(
        !proof.envHashes.includes(hash(httpLiteral)),
        'HTTP literal leaked to configured stdio sibling',
      )
    } else {
      for (const value of scopedValues)
        assert(
          !proof.envHashes.includes(hash(value)),
          'project value leaked to inherited sibling environment',
        )
    }
  }
  for (const url of bootstrapUrls)
    await assert.rejects(
      fetch(url, { signal: AbortSignal.timeout(1_000) }),
      'startup endpoint remains reachable',
    )
}
try {
  await writeFile(
    fixture,
    `
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
const marker = process.argv[2];
const hash = createHash('sha256').update(process.env.TASTECODE_FIXTURE_TOKEN ?? '').digest('hex');
const envHashes = Object.values(process.env).map((value) => createHash('sha256').update(value).digest('hex'));
const methods = [];
createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  methods.push(message.method);
  writeFileSync(marker, JSON.stringify({ hash, envHashes, methods, pid: process.pid }));
  if (!Object.hasOwn(message, 'id')) return;
  const result = message.method === 'initialize'
    ? { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'stdio-proof', version: '1.0.0' } }
    : message.method === 'tools/list'
      ? { tools: [{ name: 'ping', description: 'Local fixture', inputSchema: { type: 'object', properties: {} } }] }
      : {};
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\\n');
});
`,
    { mode: 0o600 },
  )
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  assert(address && typeof address !== 'string')
  const stdio = { type: 'stdio', command: process.execPath, args: [fixture, marker] }
  const inheritedConfig = JSON.stringify({
    mcpServers: {
      remote: { ...stdio, args: [fixture, path.join(directory, 'should-not-start.json')] },
      sibling: { ...stdio, args: [fixture, path.join(directory, 'sibling.json')] },
    },
  })
  await writeFile(path.join(directory, '.mcp.json'), inheritedConfig)
  const createAdapter = () =>
    new ClaudeCodeAdapter({
      startupTimeoutMs: 15_000,
      environment: {
        ...process.env,
        CLAUDE_CONFIG_DIR: directory,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        DISABLE_AUTOUPDATER: '1',
        ANTHROPIC_API_KEY: modelKey,
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
        ANTHROPIC_AUTH_TOKEN: undefined,
        CLAUDE_CODE_OAUTH_TOKEN: undefined,
      },
      spawn(command, args, options) {
        spawnCount += 1
        const serialized = JSON.stringify(args)
        for (const value of scopedValues) {
          assert(!serialized.includes(value), 'project value reached argv')
          assert(
            !serialized.includes(encodeURIComponent(value)),
            'encoded project value reached argv',
          )
          assert(
            !Object.values(options.env).includes(value),
            'project value reached Claude environment',
          )
        }
        assert(!serialized.includes(modelKey), 'model key reached argv')
        if (args.some((arg) => arg === '--resume' || arg.startsWith('--resume='))) resumed = true
        const index = args.indexOf('--mcp-config')
        assert(index >= 0, 'actual SDK did not supply MCP config')
        const config = JSON.parse(args[index + 1])
        assert.deepEqual(Object.keys(config.mcpServers).sort(), ['local', 'remote'])
        for (const placeholder of Object.values(config.mcpServers)) {
          assert.deepEqual(Object.keys(placeholder).sort(), ['type', 'url'])
          assert.equal(placeholder.type, 'http')
          assert.equal(new URL(placeholder.url).hostname, '127.0.0.1')
          assert.notEqual(placeholder.url, `http://127.0.0.1:${address.port}/mcp`)
          bootstrapUrls.add(placeholder.url)
        }
        const child = spawnCli(command, args, options)
        processes.push(child)
        return child
      },
      createQuery(input) {
        runtime = query({
          ...input,
          options: {
            ...input.options,
            settingSources: ['project'],
            settings: { enableAllProjectMcpServers: true },
            strictMcpConfig: false,
            mcpServers: input.options.mcpServers,
          },
        })
        return runtime
      },
    })
  adapter = createAdapter()
  adapter.on('log', (line) => logs.push(line))
  const projectOptions = {
    ephemeral: false,
    mcpServers: [
      {
        id: 'local',
        enabled: true,
        transport: {
          ...stdio,
          environment: {
            TASTECODE_FIXTURE_TOKEN: { source: 'credential', credentialRef: 'fixture/token' },
            TASTECODE_FIXTURE_MODE: { source: 'literal', value: stdioLiteral },
          },
        },
      },
      {
        id: 'remote',
        enabled: true,
        transport: {
          type: 'http',
          url: `http://127.0.0.1:${address.port}/mcp`,
          headers: {
            Authorization: { source: 'credential', credentialRef: 'fixture/http-token' },
            'X-Fixture-Mode': { source: 'literal', value: httpLiteral },
          },
        },
      },
    ],
    mcpCredentials: { 'fixture/token': canary, 'fixture/http-token': httpCanary },
  }
  const thread = await adapter.startThread(directory, projectOptions)
  const statuses = await readyMcp()
  const states = Object.fromEntries(statuses.map((status) => [status.name, status.status]))
  assert.equal(states.remote, 'connected')
  assert.equal(statuses.filter((s) => s.name === 'remote').length, 1)
  assert.equal(statuses.find((s) => s.name === 'remote').config?.type, 'http')
  assert.equal(
    statuses.find((s) => s.name === 'remote').config?.url,
    `http://127.0.0.1:${address.port}/mcp`,
  )
  for (const name of ['local', 'remote'])
    assert(
      statuses.find((status) => status.name === name)?.tools?.some((tool) => tool.name === 'ping'),
      'real tools did not replace startup placeholder',
    )
  assert.equal(states.sibling, 'connected')
  assert.equal(await readFile(path.join(directory, '.mcp.json'), 'utf8'), inheritedConfig)
  await assert.rejects(readFile(path.join(directory, 'should-not-start.json')), { code: 'ENOENT' })
  const stdioProof = JSON.parse(await readFile(marker, 'utf8'))
  assert.equal(stdioProof.hash, expectedHash, 'stdio credential was not delivered')
  assert(stdioProof.methods.includes('tools/list'))
  assert(authenticatedRequests > 0, 'HTTP credential and literal headers were not delivered')
  assert(methods.has('initialize') && methods.has('tools/list'))
  await collectFixturePids()
  await completeTurn(adapter, thread.id)
  await adapter.dispose()
  adapter = createAdapter()
  adapter.on('log', (line) => logs.push(line))
  const resumedThread = await adapter.resumeThread(thread.id, directory, projectOptions)
  assert.equal(resumedThread.id, thread.id)
  const resumedStatuses = await readyMcp()
  assert.equal(resumedStatuses.filter((server) => server.name === 'remote').length, 1)
  assert.equal(resumedStatuses.find((server) => server.name === 'remote').config?.type, 'http')
  await collectFixturePids()
  await completeTurn(adapter, resumedThread.id)
  assert.equal(spawnCount, 2)
  assert(resumed, 'SDK resume flag was not supplied')
  assert(resumedHistoryObserved, 'resumed model request did not contain the previous saved reply')
  assert(modelRequests >= 2, 'both local model turns did not complete')
  for (const secret of [canary, httpCanary])
    assert(!logs.join('\n').includes(secret), 'secret reached log output')
  assert(!logs.join('\n').includes(modelKey), 'model key reached log output')
  await adapter.dispose()
  assert(
    processes.every((child) => child.exitCode !== null || child.signalCode !== null),
    'Claude child remains alive',
  )
  for (const pid of fixturePids) {
    assert.throws(
      () => process.kill(pid, 0),
      { code: 'ESRCH' },
      'MCP fixture process remains alive',
    )
  }
  assert.equal(await readFile(path.join(directory, '.mcp.json'), 'utf8'), inheritedConfig)
  await assert.rejects(readFile(path.join(directory, 'should-not-start.json')), { code: 'ENOENT' })
  for (const entry of await readdir(directory, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue
    const contents = await readFile(path.join(entry.parentPath, entry.name))
    for (const secret of [canary, httpCanary])
      assert(!contents.includes(secret), 'MCP credential was written to a fixture file')
  }
  const sdkPackage = JSON.parse(
    await readFile(
      fileURLToPath(
        new URL('../node_modules/@anthropic-ai/claude-agent-sdk/package.json', import.meta.url),
      ),
      'utf8',
    ),
  )
  console.log(
    JSON.stringify({
      status: 'CLAUDE_MCP_RUNTIME_OK',
      sdk: sdkPackage.version,
      states,
      secretAbsentFromArgv: true,
      claudeEnvironmentHasNoProjectValues: true,
      httpCredentialScoped: true,
      stdioCredentialScoped: true,
      siblingCredentialsAbsent: true,
      bootstrapEndpointsClosed: true,
      credentialsAbsentFromFiles: true,
      inheritedReplacementSafe: true,
      savedHistoryResumed: true,
      localModelRequests: modelRequests,
      allChildrenStopped: true,
      stoppedMcpProcesses: fixturePids.size,
    }),
  )
} finally {
  await adapter?.dispose()
  const closed = new Promise((resolve) => server.close(resolve))
  server.closeAllConnections()
  await closed
  await rm(directory, { recursive: true, force: true })
}
