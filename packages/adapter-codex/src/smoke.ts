/**
 * Manual smoke test against the real `codex` binary.
 *
 *   pnpm --filter @harness/adapter-codex smoke -- "<workspace path>"
 *
 * Not part of `pnpm test` — it needs a logged-in codex and costs tokens. It
 * exists because a Tier-1 adapter is only trustworthy if it has been run
 * against the actual vendor binary, not just typechecked.
 */
import { CodexAdapter } from './adapter.js'

const workspace = process.argv[2] ?? process.cwd()
const prompt =
  process.argv[3] ?? 'Reply with exactly: hello from the harness. Do not use any tools.'

const adapter = new CodexAdapter()
adapter.on('log', (line) => console.log(`  · ${line}`))

adapter.on('event', (event) => {
  switch (event.type) {
    case 'turn.started':
      console.log(`\n▸ turn ${event.turn.id} started`)
      break
    case 'item.started':
      console.log(`  + ${event.item.type}${event.item.role ? ` (${event.item.role})` : ''}`)
      break
    case 'item.delta':
      process.stdout.write(event.textDelta)
      break
    case 'item.completed':
      if (event.item.text && event.item.type !== 'message') {
        console.log(`  = ${event.item.type}: ${event.item.text.slice(0, 120)}`)
      }
      break
    case 'turn.completed':
      console.log(`\n▸ turn ${event.status}`)
      adapter.dispose()
      process.exit(0)
    default:
      break
  }
})

console.log(`starting codex app-server in ${workspace}`)
await adapter.start()
console.log('handshake ok')

const thread = await adapter.startThread(workspace)
console.log(`thread ${thread.id}`)

await adapter.sendTurn(thread.id, prompt)

setTimeout(() => {
  console.error('\ntimed out after 90s')
  adapter.dispose()
  process.exit(1)
}, 90_000)
