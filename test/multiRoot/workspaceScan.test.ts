import { strict as assert } from 'node:assert'
import { CancellationTokenSource, ConfigurationTarget, languages, Uri, window, workspace } from 'vscode'
import { ZeroReferenceAnalyzer } from '../../src/analysis.js'
import { registerAnalysisLifecycle } from '../../src/analysisLifecycle.js'
import { ZeroReferenceWorkspaceScanner } from '../../src/workspaceScan.js'

suite('multi-root workspace scan', () => {
  test('discovers both roots and applies folder-specific exclusions', async () => {
    const first = workspace.workspaceFolders?.[0]
    const second = workspace.workspaceFolders?.[1]

    assert.ok(first !== undefined && second !== undefined)

    const firstUri = Uri.joinPath(first.uri, 'same.ts')
    const secondUri = Uri.joinPath(second.uri, 'same.ts')
    const output = window.createOutputChannel('Multi-root scan test', { log: true })
    const analyzer = new ZeroReferenceAnalyzer()
    const collection = languages.createDiagnosticCollection('multi-root-scan-test')
    const scanner = new ZeroReferenceWorkspaceScanner(analyzer, output, collection)
    const lifecycle = registerAnalysisLifecycle(analyzer)
    const cancellation = new CancellationTokenSource()
    const configuration = workspace.getConfiguration('zeroReference', firstUri)
    const previous = configuration.inspect('exclude')?.workspaceFolderValue

    try {
      const firstScan = await scanner.scan({ report: () => {} }, cancellation.token)

      assert.equal(firstScan.status, 'complete')
      assert.equal(collection.get(firstUri)?.length, 1)
      assert.equal(collection.get(secondUri)?.length, 1)
      await configuration.update('exclude', ['same.ts'], ConfigurationTarget.WorkspaceFolder)
      assert.deepEqual(collection.get(firstUri), [])
      assert.deepEqual(collection.get(secondUri), [])

      const secondScan = await scanner.scan({ report: () => {} }, cancellation.token)

      assert.equal(secondScan.skippedFiles, 1)
      assert.deepEqual(collection.get(firstUri), [])
      assert.equal(collection.get(secondUri)?.length, 1)
    } finally {
      scanner.dispose()
      lifecycle.dispose()
      analyzer.dispose()
      cancellation.dispose()
      output.dispose()
      await configuration.update('exclude', previous, ConfigurationTarget.WorkspaceFolder)
    }
  })
})
