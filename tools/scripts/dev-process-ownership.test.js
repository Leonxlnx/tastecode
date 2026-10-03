import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import {
  descendantProcesses,
  devStopTargets,
  previousRunTarget,
  verifiedRemainingPids,
} from './dev-process-ownership.js'

const root = '/work/tastecode'
const row = (pid, ppid, command, started = 'Fri Oct  3 12:00:00 2026') => ({
  pid,
  ppid,
  command,
  started,
})
const snapshot = (...rows) => new Map(rows.map((process) => [process.pid, process]))
const listeners = new Map([[5183, new Set([3])]])

test('the dev server trusts the same HTTP origin that Electron loads', () => {
  const source = readFileSync(new URL('./dev.js', import.meta.url), 'utf8')
  const launch = source.match(/^run\('server'.*$/m)?.[0]
  assert.ok(launch)
  for (const VITE_URL of ['http://127.0.0.1:5183', 'http://127.0.0.1:5510']) {
    let environment
    vm.runInNewContext(launch, {
      VITE_URL,
      URL,
      run: (_name, _package, _args, env) => {
        environment = env
      },
    })
    assert.equal(environment.HARNESS_RENDERER_ORIGIN, VITE_URL)
  }
})

test('refuses unrelated listeners and generic Vite or tsx watchers', () => {
  for (const command of [
    'node unrelated.js',
    'node vite.js',
    'node tsx watch app.ts',
    `node unrelated.js ${root}/tools/scripts/dev.js`,
    `sh -c "node ${root}/tools/scripts/dev.js"`,
  ]) {
    const processes = snapshot(row(3, 1, command))
    assert.equal(previousRunTarget(3, processes, root), undefined)
    assert.throws(() => devStopTargets(listeners, processes, root), /not a verified dev stack/)
  }
})

test('recognizes this repository launcher but not the same filename in another repo', () => {
  const processes = snapshot(
    row(2, 1, `node ${root}/tools/scripts/dev.js`),
    row(3, 2, 'node vite.js'),
  )
  assert.deepEqual([...devStopTargets(listeners, processes, root)], [2])
  assert.equal(previousRunTarget(3, processes, '/work/other'), undefined)
})

test('recognizes a recorded relative launcher only while its process identity matches', () => {
  const launcher = row(2, 1, 'node tools/scripts/dev.js')
  const processes = snapshot(launcher, row(3, 2, 'node vite.js'))
  const owner = { ...launcher, root }
  assert.equal(previousRunTarget(3, processes, root, owner), 2)
  assert.equal(
    previousRunTarget(3, processes, root, { ...owner, started: 'another run' }),
    undefined,
  )
  assert.equal(previousRunTarget(3, processes, root, { ...owner, root: '/other' }), undefined)
})

test('recognizes quoted Windows launcher paths without trusting a path prefix', () => {
  const windowsRoot = 'C:\\Projects\\Taste Code'
  const processes = snapshot(
    row(2, 1, `"C:\\Program Files\\nodejs\\node.exe" "${windowsRoot}\\tools\\scripts\\dev.js"`),
    row(3, 2, 'node vite.js'),
  )
  assert.equal(previousRunTarget(3, processes, windowsRoot, undefined, 'win32'), 2)
  assert.equal(
    previousRunTarget(3, processes, `${windowsRoot} other`, undefined, 'win32'),
    undefined,
  )
})

test('validates every occupied port before returning any stop targets', () => {
  const processes = snapshot(
    row(2, 1, `node ${root}/tools/scripts/dev.js`),
    row(3, 2, 'node vite.js'),
    row(4, 1, 'node another-server.js'),
  )
  const mixed = new Map([...listeners, [4311, new Set([4])]])
  assert.throws(() => devStopTargets(mixed, processes, root), /PID 4.*no process was stopped/)
})

test('force stop permits only previously verified descendants with unchanged identities', () => {
  const processes = snapshot(
    row(2, 1, `node ${root}/tools/scripts/dev.js`),
    row(3, 2, 'node vite.js'),
    row(4, 1, 'node unrelated.js'),
  )
  const owned = descendantProcesses(new Set([2]), processes)
  assert.deepEqual([...owned.keys()], [2, 3])
  assert.deepEqual([...verifiedRemainingPids(listeners, processes, owned)], [3])
  const reusedPid = snapshot(row(3, 1, 'node vite.js', 'a new process'))
  assert.throws(() => verifiedRemainingPids(listeners, reusedPid, owned), /ownership changed/)
  assert.throws(
    () => verifiedRemainingPids(new Map([[5183, new Set([4])]]), processes, owned),
    /ownership changed/,
  )
})

test('malformed ancestor cycles do not hang ownership checks', () => {
  const processes = snapshot(row(3, 4, 'node vite.js'), row(4, 3, 'node other.js'))
  assert.equal(previousRunTarget(3, processes, root), undefined)
})
