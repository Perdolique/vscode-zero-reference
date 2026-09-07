import { strict as assert } from 'node:assert'

import {
  CancellationTokenSource,
  ConfigurationTarget,
  DiagnosticSeverity,
  DiagnosticTag,
  DocumentSymbol,
  languages,
  Location,
  Position,
  Range,
  SymbolKind,
  Uri,
  workspace
} from 'vscode'

import type { CancellationToken, LogOutputChannel } from 'vscode'
import { ZeroReferenceAnalyzer } from '../src/analysis.js'
import type { CommandExecutor } from '../src/analysis.js'
import { registerAnalysisLifecycle } from '../src/analysisLifecycle.js'
import { ZeroReferenceWorkspaceScanner } from '../src/workspaceScan.js'
import type { ScanProgress } from '../src/workspaceScan.js'

suite('workspace scan', () => {
  let root: Uri
  let first: Uri
  let second: Uri

  suiteSetup(async () => {
    const folder = workspace.workspaceFolders?.[0]

    assert.ok(folder !== undefined)
    root = Uri.joinPath(folder.uri, 'scan-tests')
    first = Uri.joinPath(root, 'a.ts')
    second = Uri.joinPath(root, 'nested', 'b.js')
    await workspace.fs.createDirectory(Uri.joinPath(root, 'nested'))
    await workspace.fs.writeFile(first, Buffer.from('function entry() {}\n'))
    await workspace.fs.writeFile(second, Buffer.from('function entry() {}\n'))
  })

  suiteTeardown(async () => {
    await workspace.fs.delete(root, { recursive: true })
  })

  test('deduplicates, sorts, publishes name ranges and reuses unchanged analysis', async () => {
    const harness = createHarness(async () => [second, first, first])

    try {
      const result = await harness.scan()

      assert.equal(result.status, 'complete')
      assert.equal(result.checkedFiles, 2)
      assert.equal(result.findings, 2)
      assert.deepEqual(harness.symbolUris, [first.toString(), second.toString()])

      const diagnostic = harness.diagnostics.get(first)?.[0]

      assert.ok(diagnostic !== undefined)
      assert.ok(diagnostic.range.isEqual(new Range(0, 9, 0, 14)))
      assert.equal(diagnostic.source, 'Zero Reference')
      assert.equal(diagnostic.code, 'zero-reference')
      assert.equal(diagnostic.severity, DiagnosticSeverity.Information)
      assert.deepEqual(diagnostic.tags, [DiagnosticTag.Unnecessary])
      assert.ok(harness.progress.some(item => item.message?.includes('1/2:')))
      assert.equal(harness.progress.reduce((sum, item) => sum + (item.increment ?? 0), 0), 100)
      await harness.scan()
      assert.equal(harness.referenceUris.length, 2)
    } finally {
      harness.dispose()
    }
  })

  test('retains the previous snapshot until replacement and removes absent findings atomically', async () => {
    let files = [first]
    const gate = deferred()
    const started = deferred()
    let defer = false

    const harness = createHarness(async () => files, async (uri, position) => {
      if (defer) {
        started.resolve()
        await gate.promise
      }

      return [new Location(uri, new Range(position, position.translate(0, 5)))]
    })

    try {
      await harness.scan()
      files = [second]
      defer = true

      const pending = harness.scan()

      await started.promise
      assert.equal(harness.diagnostics.get(first)?.length, 1)
      assert.deepEqual(harness.diagnostics.get(second), [])
      gate.resolve()
      await pending
      assert.deepEqual(harness.diagnostics.get(first), [])
      assert.equal(harness.diagnostics.get(second)?.length, 1)
      files = []

      const empty = await harness.scan()

      assert.equal(empty.status, 'complete')
      assert.equal(empty.findings, 0)
      assert.deepEqual(harness.diagnostics.get(second), [])
    } finally {
      gate.resolve()
      harness.dispose()
    }
  })

  for (const action of ['cancel', 'clear', 'restart', 'edit', 'configuration', 'dispose']) {
    test(`${action} prevents delayed work from publishing or dequeuing another file`, async () => {
      const gate = deferred()
      const started = deferred()
      let defer = false
      let files = [first]

      const harness = createHarness(async () => files, async (uri, position) => {
        if (defer) {
          started.resolve()
          await gate.promise
        }

        return [new Location(uri, new Range(position, position.translate(0, 5)))]
      })

      try {
        await harness.scan()
        files = [second, Uri.joinPath(root, 'z.ts')]
        defer = true

        const pending = harness.scan()

        await started.promise

        if (action === 'cancel') {
          harness.cancellation.cancel()
        } else if (action === 'clear') {
          harness.scanner.clear()
        } else if (action === 'restart') {
          files = []

          const replacement = await harness.scan()

          assert.equal(replacement.status, 'complete')
        } else if (action === 'edit') {
          harness.analyzer.invalidateGraph([second])
        } else if (action === 'configuration') {
          harness.analyzer.invalidateConfiguration()
        } else {
          harness.scanner.dispose()
        }

        assert.equal((await pending).status, 'cancelled')
        gate.resolve()
        await new Promise(resolve => setTimeout(resolve, 25))
        assert.equal(harness.symbolUris.length, 2)

        if (action !== 'dispose') {
          assert.deepEqual(harness.diagnostics.get(second), [])

          const previous = harness.diagnostics.get(first)

          if (action === 'cancel' || action === 'edit') {
            assert.equal(previous?.length, 1)

            if (action === 'edit') {
              assert.ok(previous?.[0]?.message.includes('Results from a previous scan'))
              assert.deepEqual(previous?.[0]?.tags, [])
            }
          } else {
            assert.deepEqual(previous, [])
          }
        }
      } finally {
        gate.resolve()
        harness.dispose()
      }
    })
  }

  test('marks other files stale, removes changed descendants and retains the snapshot on cache eviction', async () => {
    const harness = createHarness(async () => [first, second])

    try {
      await harness.scan()
      harness.analyzer.forgetDocument(first)
      assert.equal(harness.diagnostics.get(first)?.length, 1)
      harness.analyzer.invalidateGraph([Uri.joinPath(root, 'nested')])
      assert.deepEqual(harness.diagnostics.get(second), [])
      assert.ok(harness.diagnostics.get(first)?.[0]?.message.includes('Results from a previous scan'))
      assert.deepEqual(harness.diagnostics.get(first)?.[0]?.tags, [])
      await harness.scan()
      assert.deepEqual(harness.diagnostics.get(first)?.[0]?.tags, [DiagnosticTag.Unnecessary])
      harness.analyzer.invalidateGraph([first])
      assert.deepEqual(harness.diagnostics.get(first), [])
      assert.equal(harness.diagnostics.get(second)?.length, 1)
    } finally {
      harness.dispose()
    }
  })

  test('continues after missing files and provider failures without reporting a clean scan', async () => {
    const providerError = new Error('raw scan provider failure')
    const missing = Uri.joinPath(root, 'missing.ts')

    const harness = createHarness(async () => [first, second, missing], async (uri, position) => {
      if (uri.toString() === first.toString()) {
        throw providerError
      }

      return [new Location(uri, new Range(position, position.translate(0, 5)))]
    })

    try {
      const result = await harness.scan()

      assert.equal(result.status, 'incomplete')
      assert.equal(result.checkedFiles, 1)
      assert.equal(result.incompleteFiles, 2)
      assert.equal(result.findings, 1)
      assert.ok(harness.errors.includes(providerError))
      assert.ok(harness.errors.includes(first.toString()))
      assert.deepEqual(harness.diagnostics.get(first), [])
      assert.equal(harness.diagnostics.get(second)?.length, 1)
      await harness.scan()
      assert.equal(harness.referenceUris.filter(uri => uri === first.toString()).length, 2)
    } finally {
      harness.dispose()
    }
  })

  test('keeps a previous snapshot after a raw discovery failure', async () => {
    let fail = false
    const error = new Error('raw discovery failure')

    const harness = createHarness(async () => {
      if (fail) {
        throw error
      }

      return [first]
    })

    try {
      await harness.scan()
      fail = true
      assert.equal((await harness.scan()).status, 'failed')
      assert.equal(harness.diagnostics.get(first)?.length, 1)
      assert.ok(harness.errors.includes(error))
    } finally {
      harness.dispose()
    }
  })

  test('applies native file exclusions but not search exclusions or gitignore, and skips dependencies and suppression', async () => {
    const ignored = Uri.joinPath(root, 'ignored.ts')
    const suppressed = Uri.joinPath(root, 'suppressed.ts')
    const dependency = Uri.joinPath(root, 'node_modules', 'dependency.ts')
    const gitFile = Uri.joinPath(root, '.git', 'hidden.ts')

    await workspace.fs.createDirectory(Uri.joinPath(root, 'node_modules'))
    await workspace.fs.createDirectory(Uri.joinPath(root, '.git'))

    for (const uri of [ignored, dependency, gitFile]) {
      await workspace.fs.writeFile(uri, Buffer.from('function entry() {}\n'))
    }

    await workspace.fs.writeFile(Uri.joinPath(root, '.gitignore'), Buffer.from('ignored.ts\n'))
    await workspace.fs.writeFile(suppressed, Buffer.from('// zero-reference-ignore-next-line\nfunction entry() {}\n'))

    const filesConfiguration = workspace.getConfiguration('files')
    const searchConfiguration = workspace.getConfiguration('search')
    const configuration = workspace.getConfiguration('zeroReference')
    const filesExclude = filesConfiguration.inspect('exclude')?.workspaceValue
    const searchExclude = searchConfiguration.inspect('exclude')?.workspaceValue
    const exclusions = configuration.inspect('exclude')?.workspaceValue
    const harness = createHarness()

    try {
      await filesConfiguration.update('exclude', {
        'scan-tests/a.ts': true,
        '**/.git': false
      }, ConfigurationTarget.Workspace)

      await searchConfiguration.update('exclude', { '**/ignored.ts': true }, ConfigurationTarget.Workspace)
      await configuration.update('exclude', ['scan-tests/nested/**'], ConfigurationTarget.Workspace)
      await harness.scan()
      assert.ok(harness.symbolUris.includes(ignored.toString()))
      assert.ok(harness.symbolUris.includes(suppressed.toString()))

      for (const uri of [first, second, dependency, gitFile]) {
        assert.equal(harness.symbolUris.includes(uri.toString()), false, uri.toString())
      }

      assert.equal(harness.referenceUris.includes(suppressed.toString()), false)
      assert.equal(harness.diagnostics.get(ignored)?.length, 1)
    } finally {
      harness.dispose()
      await filesConfiguration.update('exclude', filesExclude, ConfigurationTarget.Workspace)
      await searchConfiguration.update('exclude', searchExclude, ConfigurationTarget.Workspace)
      await configuration.update('exclude', exclusions, ConfigurationTarget.Workspace)
    }
  })

  test('CodeLens toggles preserve snapshots while exclusion changes clear them', async () => {
    const harness = createHarness(async () => [first])
    const lifecycle = registerAnalysisLifecycle(harness.analyzer)
    const configuration = workspace.getConfiguration('zeroReference')
    const previous = configuration.inspect('useCodeLens')?.workspaceValue
    const exclusions = configuration.inspect('exclude')?.workspaceValue

    try {
      await harness.scan()
      await configuration.update('useCodeLens', false, ConfigurationTarget.Workspace)
      assert.deepEqual(harness.diagnostics.get(first)?.[0]?.tags, [DiagnosticTag.Unnecessary])
      await configuration.update('exclude', ['scan-tests/**'], ConfigurationTarget.Workspace)
      assert.deepEqual(harness.diagnostics.get(first), [])
    } finally {
      lifecycle.dispose()
      harness.dispose()
      await configuration.update('useCodeLens', previous, ConfigurationTarget.Workspace)
      await configuration.update('exclude', exclusions, ConfigurationTarget.Workspace)
    }
  })
})

function createHarness(
  findFiles?: (token: CancellationToken) => Thenable<readonly Uri[]>,
  references?: (uri: Uri, position: Position) => Promise<readonly Location[]>
) {
  const symbolUris: string[] = []
  const referenceUris: string[] = []
  const errors: unknown[] = []
  const progress: ScanProgress[] = []

  const output: Pick<LogOutputChannel, 'error' | 'info' | 'warn'> = {
    error: (error: unknown, ...args: unknown[]): void => { errors.push(error, ...args) },
    info: (): void => {},
    warn: (): void => {}
  }

  const executeCommand: CommandExecutor = async <Result>(command: string, ...args: readonly unknown[]): Promise<Result | undefined> => {
    const uri = args[0]

    assert.ok(uri instanceof Uri)

    if (command === 'vscode.executeDocumentSymbolProvider') {
      symbolUris.push(uri.toString())

      const document = await workspace.openTextDocument(uri)
      const offset = document.getText().indexOf('function entry')

      if (offset === -1) {
        return [] as Result
      }

      const start = document.positionAt(offset)
      const range = new Range(start, start.translate(0, 19))
      const name = new Range(start.translate(0, 9), start.translate(0, 14))
      const symbol = new DocumentSymbol('entry', '', SymbolKind.Function, range, name)

      return [symbol] as Result
    }

    assert.equal(command, 'vscode.executeReferenceProvider')

    const position = args[1]

    assert.ok(position instanceof Position)
    referenceUris.push(uri.toString())

    const locations = references === undefined
      ? [new Location(uri, new Range(position, position.translate(0, 5)))]
      : await references(uri, position)

    return locations as Result
  }

  const analyzer = new ZeroReferenceAnalyzer(executeCommand, undefined, (error, uri) => {
    errors.push(error, uri.toString())
  })

  const diagnostics = languages.createDiagnosticCollection('scan-test')
  const scanner = new ZeroReferenceWorkspaceScanner(analyzer, output, diagnostics, findFiles)
  const cancellation = new CancellationTokenSource()
  let disposed = false

  return {
    analyzer,
    cancellation,
    diagnostics,
    errors,
    progress,
    referenceUris,
    scanner,
    symbolUris,
    scan: () => scanner.scan({ report: value => { progress.push(value) } }, cancellation.token),

    dispose(): void {
      if (!disposed) {
        disposed = true
        scanner.dispose()
        analyzer.dispose()
        cancellation.dispose()
      }
    }
  }
}

function deferred() {
  let resolve: () => void = () => {}
  const promise = new Promise<void>(complete => { resolve = complete })

  return {
    promise,
    resolve
  }
}
