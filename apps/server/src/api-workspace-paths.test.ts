import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  assertPublicWorkspaceFile,
  existingWorkspacePath,
  isSecretWorkspaceName,
  isSecretWorkspacePath,
  writableWorkspacePath,
} from './api-workspace-paths.js'

const RESTRICTED_PATHS = [
  '.aws/credentials',
  '.AWS\\CREDENTIALS',
  '.ssh/id_ed25519',
  '.SSH\\CONFIG',
  '.gnupg/private-keys-v1.d/key',
  '.docker/config.json',
  '.kube/config',
  '.azure/accessTokens.json',
  '.config/gcloud/credentials.db',
  'C:\\Users\\Ada\\AppData\\Roaming\\GCLOUD\\configurations\\config_default',
  'Library/Application Support/gcloud/application_default_credentials.json',
  '.netrc',
  '_NETRC',
  '.git-credentials',
  '.boto',
  'credentials.tfrc.json',
  'nested/application_default_credentials.json',
  'keys/id_ecdsa_sk',
  'keys/client.PFX',
] as const

const PUBLIC_PATHS = [
  'config.json',
  'src/config.ts',
  '.config/editor/settings.json',
  'docker/config.json',
  'kube/config',
  'aws/client.ts',
  'gcloud/client.ts',
  'src/roaming/gcloud/client.ts',
  'docs/Application Support/gcloud/readme.md',
  'credentials.example.json',
  'application_default_credentials.example.json',
] as const

describe('direct API workspace path policy', () => {
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
      path.join(workspace, 'src', 'components', 'Card.tsx'),
    )
  })

  it('recognizes common credential names', () => {
    expect(isSecretWorkspaceName('.env.local')).toBe(true)
    expect(isSecretWorkspaceName('client.pem')).toBe(true)
    expect(() => assertPublicWorkspaceFile(path.join('project', '.git', 'config'))).toThrow(
      'credential files are not available',
    )
  })

  it.each(RESTRICTED_PATHS)('rejects credential path %s across path styles and case', (target) => {
    expect(isSecretWorkspacePath(target)).toBe(true)
    expect(() => assertPublicWorkspaceFile(target)).toThrow('credential files are not available')
  })

  it.each(PUBLIC_PATHS)('does not overblock ordinary repository path %s', (target) => {
    expect(isSecretWorkspacePath(target)).toBe(false)
    expect(() => assertPublicWorkspaceFile(target)).not.toThrow()
  })
})
