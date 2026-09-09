import { mkdtempSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  assertPublicWorkspaceFile,
  existingWorkspacePath,
  isSecretWorkspaceName,
  writableWorkspacePath,
} from './api-workspace-paths.js'

describe('direct API workspace path policy', () => {
  it('blocks cloud credentials and hidden credential directories through aliases', () => {
    const workspace = mkdtempSync(path.join(tmpdir(), 'harness-api-policy-'))
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
    const workspace = mkdtempSync(path.join(tmpdir(), 'harness-api-alias-'))
    mkdirSync(path.join(workspace, 'source'))
    symlinkSync(path.join(workspace, 'source'), path.join(workspace, 'alias'), 'junction')
    expect(writableWorkspacePath(workspace, 'alias/nested/new.txt')).toBe(
      path.join(realpathSync(workspace), 'source', 'nested', 'new.txt'),
    )
    expect(isSecretWorkspaceName('tsconfig.json')).toBe(false)
  })
  it('keeps reads and writes inside the real workspace', () => {
    const workspace = mkdtempSync(path.join(tmpdir(), 'harness-api-paths-'))
    const outside = mkdtempSync(path.join(tmpdir(), 'harness-api-outside-'))
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
    const workspace = mkdtempSync(path.join(tmpdir(), 'harness-api-paths-'))
    mkdirSync(path.join(workspace, 'src'))
    expect(writableWorkspacePath(workspace, 'src/components/Card.tsx')).toBe(
      path.join(realpathSync(workspace), 'src', 'components', 'Card.tsx'),
    )
  })

  it('recognizes common credential files', () => {
    expect(isSecretWorkspaceName('.env.local')).toBe(true)
    expect(isSecretWorkspaceName('client.pem')).toBe(true)
    expect(() => assertPublicWorkspaceFile(path.join('project', '.git', 'config'))).toThrow(
      'credential files are not available',
    )
  })
})
