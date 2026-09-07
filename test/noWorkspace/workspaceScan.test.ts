import { strict as assert } from 'node:assert'
import { CancellationTokenSource, languages, workspace } from 'vscode'
import { ZeroReferenceAnalyzer } from '../../src/analysis.js'
import { ZeroReferenceWorkspaceScanner } from '../../src/workspaceScan.js'

suite('workspace scan without a workspace', () => {
  test('does not search or analyze untitled documents', async () => {
    assert.equal(workspace.workspaceFolders, undefined)

    await workspace.openTextDocument({
      content: 'function entry() {}',
      language: 'typescript'
    })

    const output = {
      info: () => {},
      warn: () => {},
      error: () => {}
    }

    const analyzer = new ZeroReferenceAnalyzer()
    const collection = languages.createDiagnosticCollection('no-workspace-scan-test')

    const scanner = new ZeroReferenceWorkspaceScanner(analyzer, output, collection, async () => {
      assert.fail('must not search without workspace folders')
    })

    const cancellation = new CancellationTokenSource()

    try {
      const result = await scanner.scan({ report: () => {} }, cancellation.token)

      assert.equal(result.status, 'noWorkspace')
      assert.equal(result.findings, 0)
    } finally {
      scanner.dispose()
      analyzer.dispose()
      cancellation.dispose()
    }
  })
})
