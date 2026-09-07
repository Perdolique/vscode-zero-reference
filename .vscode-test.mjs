import { defineConfig } from '@vscode/test-cli'
import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Tests update settings and workspace folders only in disposable copies of the fixtures.
const temporaryRoot = process.platform === 'darwin' ? '/tmp' : tmpdir()
const fixtureDirectory = mkdtempSync(join(temporaryRoot, 'zero-reference-tests-'))
const singleRoot = join(fixtureDirectory, 'single-root')
const multiRoot = join(fixtureDirectory, 'multi-root')

cpSync(new URL('./test/fixtures/workspace', import.meta.url), singleRoot, { recursive: true })
cpSync(new URL('./test/fixtures/multi-root', import.meta.url), multiRoot, { recursive: true })

for (const folder of [singleRoot, join(multiRoot, 'first'), join(multiRoot, 'second')]) {
  mkdirSync(join(folder, '.vscode'), { recursive: true })
}

process.on('exit', () => rmSync(fixtureDirectory, {
  recursive: true,
  force: true
}))

const shared = {
  version: '1.125.0',
  launchArgs: ['--disable-extensions', '--new-window'],

  mocha: {
    failZero: true,
    timeout: 60_000
  }
}

export default defineConfig([
  {
    ...shared,
    label: 'scan-integration',
    files: 'build-test/test/scanIntegration/*.test.js',
    workspaceFolder: singleRoot
  },
  {
    ...shared,
    label: 'single-root',
    files: 'build-test/test/*.test.js',
    workspaceFolder: singleRoot
  },
  {
    ...shared,
    label: 'multi-root',
    files: 'build-test/test/multiRoot/*.test.js',
    workspaceFolder: join(multiRoot, 'workspace.code-workspace')
  },
  {
    ...shared,
    label: 'no-workspace',
    files: 'build-test/test/noWorkspace/*.test.js'
  }
])
