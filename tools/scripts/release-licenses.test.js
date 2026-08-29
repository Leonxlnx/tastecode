import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  auditInstalledProductionGraph,
  deriveDirectRuntimeDependencies,
  loadLicenseInventory,
  renderDirectRuntimeTable,
  verifyDirectRuntimeTable,
  verifyProjectLicense,
} from './release-licenses.js'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
let fixtureRoot

async function json(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

async function installedPackage(name, packageJson) {
  const packageRoot = path.join(fixtureRoot, 'node_modules', ...name.split('/'))
  await json(path.join(packageRoot, 'package.json'), { name, ...packageJson })
  await writeFile(path.join(packageRoot, 'LICENSE.fixture'), 'fixture license\n', 'utf8')
}

before(async () => {
  fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'tastecode-license-test-'))
  await json(path.join(fixtureRoot, 'apps/desktop/package.json'), {
    name: '@fixture/desktop',
    dependencies: { '@fixture/server': 'workspace:*', 'external-a': '1.0.0' },
  })
  await json(path.join(fixtureRoot, 'apps/web/package.json'), {
    name: '@fixture/web',
    dependencies: { 'external-web': '1.0.0' },
  })
  await json(path.join(fixtureRoot, 'packages/server/package.json'), {
    name: '@fixture/server',
    dependencies: { 'external-a': '1.0.0' },
  })
  await installedPackage('external-a', {
    version: '1.0.0',
    license: 'MIT',
    dependencies: { 'transitive-b': '2.0.0' },
  })
  await installedPackage('external-web', { version: '1.0.0', license: 'Apache-2.0' })
  await installedPackage('transitive-b', { version: '2.0.0', license: 'BSD-3-Clause' })
})

after(async () => {
  await rm(fixtureRoot, { recursive: true, force: true })
})

test('the checked-in notice table exactly matches every direct runtime dependency', async () => {
  const inventory = await loadLicenseInventory(repositoryRoot)
  const derived = await deriveDirectRuntimeDependencies(repositoryRoot, inventory)

  assert.deepEqual(
    derived.map(({ name }) => name),
    inventory.dependencies.map(({ name }) => name),
  )
  await assert.doesNotReject(verifyDirectRuntimeTable(repositoryRoot, inventory))
  assert.match(renderDirectRuntimeTable(inventory), /`electron-updater`/)
  assert.match(renderDirectRuntimeTable(inventory), /`@anthropic-ai\/claude-agent-sdk`/)
})

test('the installed graph report includes transitives and license-file evidence', async () => {
  const inventory = {
    workspaceRoots: ['apps/desktop', 'apps/web'],
    runtimeDevDependencies: {},
    dependencies: [
      {
        name: 'external-a',
        use: 'fixture',
        license: 'MIT',
        metadataLicenses: ['MIT'],
        source: 'https://example.test/a',
      },
      {
        name: 'external-web',
        use: 'fixture',
        license: 'Apache-2.0',
        metadataLicenses: ['Apache-2.0'],
        source: 'https://example.test/web',
      },
    ],
    reviewedTransitiveExceptions: [],
  }
  const derived = await deriveDirectRuntimeDependencies(fixtureRoot, inventory)
  const { report, licenseBundle } = await auditInstalledProductionGraph(
    fixtureRoot,
    inventory,
    derived,
  )

  assert.equal(report.packageCount, 3)
  assert.deepEqual(
    report.packages.map(({ name }) => name),
    ['external-a', 'external-web', 'transitive-b'],
  )
  assert.deepEqual(report.packages[0].licenseFiles, ['LICENSE.fixture'])
  assert.match(licenseBundle, /external-web@1\.0\.0/)
  assert.match(licenseBundle, /fixture license/)
})

test('unknown license metadata fails closed', async () => {
  const transitivePackage = path.join(fixtureRoot, 'node_modules/transitive-b/package.json')
  const original = await readFile(transitivePackage, 'utf8')
  await json(transitivePackage, {
    name: 'transitive-b',
    version: '2.0.0',
    license: 'Unknown-Custom-License',
  })
  const inventory = {
    workspaceRoots: ['apps/desktop'],
    runtimeDevDependencies: {},
    dependencies: [
      {
        name: 'external-a',
        use: 'fixture',
        license: 'MIT',
        metadataLicenses: ['MIT'],
        source: 'https://example.test/a',
      },
    ],
    reviewedTransitiveExceptions: [],
  }

  try {
    const derived = await deriveDirectRuntimeDependencies(fixtureRoot, inventory)
    await assert.rejects(
      auditInstalledProductionGraph(fixtureRoot, inventory, derived),
      /unreviewed license metadata: Unknown-Custom-License/,
    )
  } finally {
    await writeFile(transitivePackage, original, 'utf8')
  }
})

test('an exact reviewed exception can supply missing metadata and bundled license evidence', async () => {
  const packageRoot = path.join(fixtureRoot, 'node_modules/transitive-b')
  const packageJsonPath = path.join(packageRoot, 'package.json')
  const packageJson = await readFile(packageJsonPath, 'utf8')
  const packageLicense = path.join(packageRoot, 'LICENSE.fixture')
  const bundledLicense = path.join(fixtureRoot, 'licenses/transitive-b-MIT.txt')
  await json(packageJsonPath, { name: 'transitive-b', version: '2.0.0' })
  await rm(packageLicense)
  await mkdir(path.dirname(bundledLicense), { recursive: true })
  await writeFile(bundledLicense, `MIT License\n${'reviewed '.repeat(20)}\n`, 'utf8')

  try {
    const inventory = {
      workspaceRoots: ['apps/desktop'],
      runtimeDevDependencies: {},
      dependencies: [
        {
          name: 'external-a',
          use: 'fixture',
          license: 'MIT',
          metadataLicenses: ['MIT'],
          source: 'https://example.test/a',
        },
      ],
      reviewedTransitiveExceptions: [
        {
          name: 'transitive-b',
          version: '2.0.0',
          license: 'MIT',
          allowMissingMetadata: true,
          bundledLicense: 'licenses/transitive-b-MIT.txt',
          licenseSource: 'https://example.test/transitive-b-license',
        },
      ],
    }
    const derived = await deriveDirectRuntimeDependencies(fixtureRoot, inventory)
    const { report, licenseBundle } = await auditInstalledProductionGraph(
      fixtureRoot,
      inventory,
      derived,
    )
    assert.deepEqual(report.packages.at(-1).licenseFiles, ['licenses/transitive-b-MIT.txt'])
    assert.match(licenseBundle, /transitive-b-MIT\.txt/)
  } finally {
    await writeFile(packageJsonPath, packageJson, 'utf8')
    await writeFile(packageLicense, 'fixture license\n', 'utf8')
  }
})

test('the checked-in inventory reviews the Linux Claude SDK package and ships its license', async () => {
  const checkedInInventory = await loadLicenseInventory(repositoryRoot)
  const externalPackageJsonPath = path.join(fixtureRoot, 'node_modules/external-a/package.json')
  const originalExternalPackageJson = await readFile(externalPackageJsonPath, 'utf8')
  const linuxPackageName = '@anthropic-ai/claude-agent-sdk-linux-x64'
  const linuxPackageRoot = path.join(fixtureRoot, 'node_modules', ...linuxPackageName.split('/'))

  try {
    await json(externalPackageJsonPath, {
      name: 'external-a',
      version: '1.0.0',
      license: 'MIT',
      dependencies: { [linuxPackageName]: '0.3.232' },
    })
    await installedPackage(linuxPackageName, {
      version: '0.3.232',
      license: 'SEE LICENSE IN LICENSE.md',
    })
    await rm(path.join(linuxPackageRoot, 'LICENSE.fixture'))
    await writeFile(
      path.join(linuxPackageRoot, 'LICENSE.md'),
      'Anthropic SDK license terms\n',
      'utf8',
    )

    const inventory = {
      workspaceRoots: ['apps/desktop'],
      runtimeDevDependencies: {},
      dependencies: [
        {
          name: 'external-a',
          use: 'fixture',
          license: 'MIT',
          metadataLicenses: ['MIT'],
          source: 'https://example.test/a',
        },
      ],
      reviewedTransitiveExceptions: checkedInInventory.reviewedTransitiveExceptions,
    }
    const derived = await deriveDirectRuntimeDependencies(fixtureRoot, inventory)
    const { report, licenseBundle } = await auditInstalledProductionGraph(
      fixtureRoot,
      inventory,
      derived,
    )
    const linuxPackage = report.packages.find(({ name }) => name === linuxPackageName)

    assert.ok(linuxPackage)
    assert.equal(linuxPackage.reviewedLicense, 'LicenseRef-Anthropic-Commercial-Terms')
    assert.deepEqual(linuxPackage.licenseFiles, ['LICENSE.md'])
    assert.match(licenseBundle, /claude-agent-sdk-linux-x64@0\.3\.232/)
    assert.match(licenseBundle, /--- LICENSE\.md ---/)
  } finally {
    await writeFile(externalPackageJsonPath, originalExternalPackageJson, 'utf8')
    await rm(linuxPackageRoot, { recursive: true, force: true })
  }
})

test('a short link-only project license is rejected', async () => {
  await assert.rejects(verifyProjectLicense(fixtureRoot), /top-level LICENSE is missing/)
  await writeFile(path.join(fixtureRoot, 'LICENSE'), 'Apache-2.0: see upstream\n', 'utf8')
  await assert.rejects(verifyProjectLicense(fixtureRoot), /not the complete Apache-2.0/)
})
