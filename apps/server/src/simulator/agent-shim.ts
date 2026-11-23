import { createHash } from 'node:crypto'
import { chmod, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { SimulatorDevice } from '@harness/contracts'
import { resolveNodeExecutable, simulatorStateDir } from './toolchain.js'

const TARGETS_SUBDIR = 'targets'
const HOSTS_SUBDIR = 'hosts'
const STALE_RUNTIME =
  'This agent-device command is out of date because TasteCode moved or updated its runtime. Call device_open again for a fresh one.'

const quoteShell = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'"

/** Flags in agent-device 0.21.36 that take a value, so the launcher finds the subcommand past them. */
const VALUE_FLAGS: readonly string[] = [
  '--activity',
  '--all',
  '--android-device-allowlist',
  '--app',
  '--appium-version',
  '--artifact',
  '--artifacts-dir',
  '--aws-app-arn',
  '--aws-device-arn',
  '--aws-interaction-mode',
  '--aws-project-arn',
  '--aws-region',
  '-b',
  '--baseline',
  '--bearer-token',
  '--bundle-url',
  '--button',
  '--config',
  '--count',
  '--crop-on',
  '--custom-network',
  '-d',
  '--daemon-auth-token',
  '--daemon-base-url',
  '--daemon-server-mode',
  '--daemon-transport',
  '--delay-ms',
  '--depth',
  '--device',
  '--device-orientation',
  '--dsym',
  '--duration-ms',
  '--fps',
  '--from',
  '--geo-location',
  '--github-actions-artifact',
  '--header',
  '--hold-ms',
  '--host',
  '--image-tag',
  '--in-app',
  '--include',
  '--interval-ms',
  '--ios-simulator-device-set',
  '--ios-xctest-derived-data-path',
  '--ios-xctest-env-dir',
  '--ios-xctestrun-file',
  '--jitter-px',
  '--keyframes',
  '--kind',
  '--language',
  '--launch-args',
  '--launch-console',
  '--launch-url',
  '--lease-backend',
  '--lease-id',
  '--level',
  '--listen-host',
  '--locale',
  '--max-passes',
  '--max-steps',
  '--metro-host',
  '--metro-kind',
  '--metro-port',
  '--network-profile',
  '--on-error',
  '--os',
  '--os-version',
  '--out',
  '--pattern',
  '--pause-ms',
  '--pixel-density',
  '--pixels',
  '--plan-digest',
  '--platform',
  '--pointer-count',
  '--port',
  '--probe-timeout-ms',
  '--project-root',
  '--provider',
  '--provider-app',
  '--provider-appium-version',
  '--provider-build',
  '--provider-custom-network',
  '--provider-device-orientation',
  '--provider-device-type',
  '--provider-geo-location',
  '--provider-language',
  '--provider-locale',
  '--provider-network-hosts',
  '--provider-network-profile',
  '--provider-os-version',
  '--provider-project',
  '--provider-session',
  '--provider-session-name',
  '--provider-timezone',
  '--proxy-base-url',
  '--public-base-url',
  '--quality',
  '--record-as',
  '--remote-config',
  '--reporter',
  '--report-junit',
  '--retention-ms',
  '--retries',
  '--run-id',
  '--runtime-file',
  '-s',
  '--scale',
  '--scope',
  '--search-path',
  '--serial',
  '--session',
  '--session-isolation',
  '--session-lock',
  '--settle-quiet',
  '--shard-all',
  '--shard-split',
  '--startup-timeout-ms',
  '--state-dir',
  '--status-host',
  '--steps',
  '--steps-file',
  '--surface',
  '--system',
  '--target',
  '--target-app',
  '--template',
  '--tenant',
  '--threshold',
  '--timeout',
  '--timezone',
  '--udid',
  '--until',
  '--wait',
]

function hashKey(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 24)
}

export function agentDeviceSessionId(threadId: string, deviceId: string): string {
  return `tc-${hashKey(JSON.stringify([threadId, deviceId]))}`
}

export function agentDeviceConfigPath(dataRoot: string, key = 'local'): string {
  return path.join(simulatorStateDir(dataRoot), HOSTS_SUBDIR, `${hashKey(key)}.json`)
}

export async function writeAgentDeviceConfig(
  filePath: string,
  endpoint: { readonly baseUrl: string; readonly token: string },
): Promise<void> {
  const dir = path.dirname(filePath)
  await mkdir(dir, { recursive: true })
  const content = JSON.stringify({
    daemonBaseUrl: endpoint.baseUrl,
    daemonAuthToken: endpoint.token,
  })
  const current = await readFile(filePath, 'utf8').catch(() => '')
  if (current === content) return
  const temporary = path.join(dir, `.endpoint-${hashKey(`${Date.now()}-${Math.random()}`)}.tmp`)
  try {
    await writeFile(temporary, content, { encoding: 'utf8', mode: 0o600 })
    if (process.platform !== 'win32') await chmod(temporary, 0o600)
    await rename(temporary, filePath)
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined)
  }
}

function launcherSource(node: string, entryPath: string, boundArgs: readonly string[]): string {
  return `import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { connect } from "node:net";
const entry = ${JSON.stringify(entryPath)};
const bound = ${JSON.stringify(boundArgs)};
const refused = new Map([["cdp", ["--platform", "--udid", "--serial", "--config", "--session"]], ["connection", ["--platform", "--udid", "--serial"]]]);
const managed = ["connect", "disconnect", "auth", "daemon"];
const args = process.argv.slice(2);
const end = args.indexOf("--");
const options = end < 0 ? args : args.slice(0, end);
const valued = new Set(${JSON.stringify(VALUE_FLAGS)});
let name = "";
for (let index = 0; index < args.length; index++) {
  const arg = args[index];
  if (arg === "--") { name = args[index + 1] ?? ""; break; }
  if (!arg.startsWith("-")) { name = arg; break; }
  if (!arg.includes("=") && valued.has(arg)) index++;
}
const informational = args.length === 0 || ["help", "--help", "-h", "--version", "version"].includes(args[0]) || options.includes("--help") || options.includes("-h");
if (!informational && managed.includes(name)) {
  console.error("TasteCode manages this command's connection to the simulator, so \`" + name + "\` is not available through it.");
  process.exit(1);
}
if (!informational && name === "device") {
  console.error("\`device status\` is managed by TasteCode and is not available through this command.");
  process.exit(1);
}
const skip = refused.get(name) ?? [];
if (!informational) {
  for (let index = 0; index + 1 < bound.length; index += 2) {
    if (!skip.includes(bound[index]) && !options.some(arg => arg === bound[index] || arg.startsWith(bound[index] + "="))) {
      options.push(bound[index], bound[index + 1]);
    }
  }
}
const command = end < 0 ? options : [...options, ...args.slice(end)];
const hasValue = flag => {
  const index = options.indexOf(flag);
  return options.some(arg => arg.startsWith(flag + "=") && arg.length > flag.length + 1) || (index >= 0 && !!options[index + 1] && !options[index + 1].startsWith("--"));
};
if (!informational && !skip.includes("--session") && !(hasValue("--config") && hasValue("--session"))) {
  console.error("Call device_open first and run the agent-device command it returns.");
  process.exit(1);
}
if (!existsSync(entry)) {
  console.error(${JSON.stringify(STALE_RUNTIME)});
  process.exit(1);
}
const valueOf = flag => {
  const inline = options.find(arg => arg.startsWith(flag + "="));
  if (inline) return inline.slice(flag.length + 1);
  const index = options.indexOf(flag);
  return index >= 0 ? options[index + 1] : undefined;
};
const endpoint = () => {
  try {
    const url = new URL(valueOf("--daemon-base-url") ?? JSON.parse(readFileSync(valueOf("--config"), "utf8")).daemonBaseUrl);
    return ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) && url.port ? url : undefined;
  } catch {
    return undefined;
  }
};
const local = informational || refused.has(name) ? undefined : endpoint();
if (local) {
  const failure = await new Promise(resolve => {
    const socket = connect({ host: local.hostname.replace(/^\\[|\\]$/g, ""), port: Number(local.port) });
    socket.setTimeout(3000, () => { socket.destroy(); resolve("ETIMEDOUT"); });
    socket.once("connect", () => { socket.destroy(); resolve(undefined); });
    socket.once("error", error => resolve(error.code ?? "ERROR"));
  });
  if (failure === "EPERM" || failure === "EACCES") {
    console.error("This shell cannot reach TasteCode's simulator connection at " + local.host + " (connect " + failure + "): a network sandbox is blocking localhost. Run this command again with network access, outside the sandbox.");
    process.exit(1);
  }
  if (failure) {
    console.error("TasteCode's simulator connection at " + local.host + " is not reachable from this shell (connect " + failure + "). Call device_open again to reconnect; if that succeeds and this repeats, this shell runs in a network sandbox.");
    process.exit(1);
  }
}
const env = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
delete env.AGENT_DEVICE_DAEMON_BASE_URL;
delete env.AGENT_DEVICE_DAEMON_AUTH_TOKEN;
delete env.AGENT_DEVICE_CONFIG;
const child = spawn(${JSON.stringify(node)}, [entry, ...command], { stdio: "inherit", env });
child.on("error", error => { console.error(error.message); process.exitCode = 1; });
child.on("exit", code => { process.exitCode = code ?? 1; });
`
}

export async function bindAgentDeviceLauncher(input: {
  readonly dataRoot: string
  readonly entryPath: string
  readonly session: string
  readonly targetArgs: readonly string[]
  readonly env?: NodeJS.ProcessEnv
}): Promise<string> {
  const { executable: node } = await resolveNodeExecutable(input.env)
  const dir = path.join(simulatorStateDir(input.dataRoot), TARGETS_SUBDIR, input.session)
  await mkdir(dir, { recursive: true })
  const launcherPath = path.join(dir, 'agent-device-launcher.mjs')
  await writeFile(launcherPath, launcherSource(node, input.entryPath, input.targetArgs), 'utf8')
  if (process.platform === 'win32') {
    const script = `@echo off\r\nsetlocal EnableExtensions DisableDelayedExpansion\r\nif not exist "${node}" (echo ${STALE_RUNTIME} 1>&2 & exit /b 1)\r\nset "ELECTRON_RUN_AS_NODE=1"\r\n"${node}" "${launcherPath}" %*\r\n`
    const scriptPath = path.join(dir, 'agent-device.cmd')
    await writeFile(scriptPath, script, 'utf8')
    return scriptPath
  }
  const script = `#!/bin/sh\n[ -x ${quoteShell(node)} ] || { echo ${quoteShell(STALE_RUNTIME)} >&2; exit 1; }\nexport ELECTRON_RUN_AS_NODE=1\nexec ${quoteShell(node)} ${quoteShell(launcherPath)} "$@"\n`
  const scriptPath = path.join(dir, 'agent-device')
  await writeFile(scriptPath, script, 'utf8')
  await chmod(scriptPath, 0o755)
  return scriptPath
}

export async function removeAgentDeviceLauncher(dataRoot: string, session: string): Promise<void> {
  const dir = path.join(simulatorStateDir(dataRoot), TARGETS_SUBDIR, session)
  await rm(dir, { recursive: true, force: true }).catch(() => undefined)
}

export async function pruneAgentDeviceLaunchers(
  dataRoot: string,
  liveSessions: ReadonlySet<string>,
): Promise<void> {
  const dir = path.join(simulatorStateDir(dataRoot), TARGETS_SUBDIR)
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return
  }
  await Promise.all(
    entries
      .filter((entry) => !liveSessions.has(entry))
      .map((entry) => rm(path.join(dir, entry), { recursive: true, force: true }).catch(() => {})),
  )
}

export function agentDeviceTargetArgs(device: Pick<SimulatorDevice, 'platform' | 'id'>): string[] {
  return device.platform === 'ios'
    ? ['--platform', 'ios', '--udid', device.id]
    : ['--platform', 'android', '--serial', device.id]
}

const shellWord = (value: string) =>
  /^[a-zA-Z0-9_./:-]+$/.test(value) ? value : "'" + value.replaceAll("'", "'\"'\"'") + "'"

export function agentDeviceQuickStart(device: SimulatorDevice, command: string): string {
  const executable = shellWord(command)
  const run = (args: string) => `${executable} ${args}`
  const platformNote =
    device.platform === 'ios'
      ? 'First use builds an XCTest runner and can take a couple of minutes; later commands are fast.'
      : 'The Android snapshot helper installs itself on first use.'

  return [
    `The user is watching ${device.name} (${device.version}) in the Simulator panel.`,
    `Drive it with ${executable}. It is bound to this device and session, so it needs no --platform, --udid, --serial, --config or --session flags. Use this exact path; login shells may reset PATH.`,
    'Every app launch, deep link, tap, text entry, alert, setting, screenshot and recording on this device goes through it. Run open <bundle-or-package-id> (apps lists them) before snapshots, CLI screenshots or input; it starts the session they need. Use device_screenshot just to look.',
    `  ${run('open <bundle-or-package-id> --relaunch')}  # restarts the app; Expo dev clients connect to their Metro, --metro-port <port> picks it`,
    `  ${run('open <bundle-or-package-id> <deep-link-url>')}`,
    `  ${run('snapshot -i')}  # accessibility tree with @eN refs`,
    `  ${run('press @e3 --settle')}`,
    `  ${run('fill @e5 "text" --settle')}`,
    `  ${run('alert accept')}`,
    `  ${run('settings appearance dark')}  # also text-size, permission grant <name>`,
    `  ${run('screenshot /tmp/shot.png')}  # ${device.platform === 'ios' ? 'iOS saves 1x points; add --pixel-density <n> (3 on most iPhones) for device resolution, ' : ''}or call device_screenshot to look`,
    `  ${run('record start --scope device /tmp/run.mp4')}  # then record stop`,
    `  ${run('install <app> <path-to-.app-or-.apk>')}`,
    `Prefer snapshot refs over coordinates. Run ${executable} help <command> for flags and ${executable} help workflow for guides.`,
    'Do not use simctl, idb, or adb for those UI actions. They stay fine for builds, installs, Metro, port forwards, logs, test runners and what this command cannot do; come back to it for every UI action and screenshot so the user can watch.',
    'Each device_open returns its own command; opening another device does not retarget this one.',
    'The command is removed when the device closes or TasteCode restarts. If it is missing, call device_open again.',
    platformNote,
  ].join('\n')
}
