import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  assertPublicWorkspaceFile,
  existingWorkspacePath,
  isSecretWorkspaceName,
  writableWorkspacePath,
} from './api-workspace-paths.js'

const workspaces: string[] = []
function workspaceDirectory(prefix: string): string {
  const directory = mkdtempSync(prefix)
  workspaces.push(directory)
  return directory
}
afterEach(() => {
  for (const workspace of workspaces.splice(0)) rmSync(workspace, { recursive: true, force: true })
})

describe('direct API workspace path policy', () => {
  it.each(['.boto', '_netrc', 'credentials.tfrc.json', 'application_default_credentials.json'])(
    'protects %s from reads, writes, and case variants',
    (name) => {
      const workspace = workspaceDirectory(path.join(tmpdir(), 'harness-extra-credential-'))
      writeFileSync(path.join(workspace, name), 'synthetic credential')
      expect(() => existingWorkspacePath(workspace, name, false)).toThrow(/credential/)
      expect(() => writableWorkspacePath(workspace, name)).toThrow(/credential/)
      expect(() =>
        writableWorkspacePath(workspace, path.join('nested', name.toUpperCase())),
      ).toThrow(/credential/)
      expect(writableWorkspacePath(workspace, 'terraform.tf')).toBe(
        path.join(realpathSync(workspace), 'terraform.tf'),
      )
    },
  )
  it('blocks cloud credentials and hidden credential directories through aliases', () => {
    const workspace = workspaceDirectory(path.join(tmpdir(), 'harness-api-policy-'))
    for (const directory of ['.aws', '.ssh', '.git']) mkdirSync(path.join(workspace, directory))
    writeFileSync(path.join(workspace, '.aws', 'credentials'), 'synthetic canary')
    writeFileSync(path.join(workspace, '.ssh', 'id_ecdsa'), 'synthetic canary')
    symlinkSync(path.join(workspace, '.git'), path.join(workspace, 'public-folder'), 'junction')
    for (const file of ['.aws/credentials', '.ssh/id_ecdsa']) {
      expect(() => existingWorkspacePath(workspace, file, false)).toThrow(/credential/)
    }
    expect(() => existingWorkspacePath(workspace, '.aws', true)).toThrow(/credential/)
    expect(() => writableWorkspacePath(workspace, 'public-folder/hooks/pre-commit')).toThrow(
      /credential/,
    )
  })

  it('resolves a permitted alias to the path used for review and writes', () => {
    const workspace = workspaceDirectory(path.join(tmpdir(), 'harness-api-alias-'))
    mkdirSync(path.join(workspace, 'source'))
    symlinkSync(path.join(workspace, 'source'), path.join(workspace, 'alias'), 'junction')
    expect(writableWorkspacePath(workspace, 'alias/nested/new.txt')).toBe(
      path.join(realpathSync(workspace), 'source', 'nested', 'new.txt'),
    )
    expect(isSecretWorkspaceName('tsconfig.json')).toBe(false)
  })
  it('keeps reads and writes inside the real workspace', () => {
    const workspace = workspaceDirectory(path.join(tmpdir(), 'harness-api-paths-'))
    const outside = workspaceDirectory(path.join(tmpdir(), 'harness-api-outside-'))
    writeFileSync(path.join(outside, 'secret.txt'), 'secret')
    symlinkSync(outside, path.join(workspace, 'linked'), 'junction')

    expect(() => existingWorkspacePath(workspace, '../outside', false)).toThrow(
      'path escapes the workspace',
    )
    expect(() => existingWorkspacePath(workspace, 'linked/secret.txt', false)).toThrow(
      'path escapes the workspace',
    )
    expect(() => writableWorkspacePath(workspace, 'linked/new.txt')).toThrow(
      'path escapes the workspace',
    )
  })

  it('allows nested destinations under a real workspace directory', () => {
    const workspace = workspaceDirectory(path.join(tmpdir(), 'harness-api-paths-'))
    mkdirSync(path.join(workspace, 'src'))
    expect(writableWorkspacePath(workspace, 'src/components/Card.tsx')).toBe(
      path.join(realpathSync(workspace), 'src', 'components', 'Card.tsx'),
    )
  })

  it.each(['gcloud', '.docker', 'release.key'])(
    'allows a workspace that lives under a folder named %s',
    (parent) => {
      const root = workspaceDirectory(path.join(tmpdir(), 'harness-api-parent-'))
      const workspace = path.join(root, parent, 'site')
      mkdirSync(workspace, { recursive: true })
      writeFileSync(path.join(workspace, 'index.html'), '<p>hi</p>')
      writeFileSync(path.join(workspace, '.env'), 'synthetic canary')
      const real = realpathSync(workspace)
      expect(existingWorkspacePath(workspace, 'index.html', false)).toBe(
        path.join(real, 'index.html'),
      )
      expect(existingWorkspacePath(workspace, '.', true)).toBe(real)
      expect(writableWorkspacePath(workspace, 'src/new.txt')).toBe(
        path.join(real, 'src', 'new.txt'),
      )
      expect(() => existingWorkspacePath(workspace, '.env', false)).toThrow(/credential/)
      expect(() => writableWorkspacePath(workspace, '.git/config')).toThrow(/credential/)
    },
  )

  it.each(['.aws', '.kube', 'gcloud'])(
    'still rejects a workspace opened directly on %s',
    (name) => {
      const root = workspaceDirectory(path.join(tmpdir(), 'harness-api-secret-root-'))
      const workspace = path.join(root, name)
      mkdirSync(workspace, { recursive: true })
      writeFileSync(path.join(workspace, 'config'), 'synthetic canary')
      expect(() => existingWorkspacePath(workspace, 'config', false)).toThrow(/credential/)
      expect(() => writableWorkspacePath(workspace, 'new.txt')).toThrow(/credential/)
    },
  )

  it('recognizes common credential files', () => {
    expect(isSecretWorkspaceName('.env.local')).toBe(true)
    expect(isSecretWorkspaceName('client.pem')).toBe(true)
    expect(() => assertPublicWorkspaceFile(path.join('project', '.git', 'config'))).toThrow(
      'credential files are not available',
    )
  })
})
