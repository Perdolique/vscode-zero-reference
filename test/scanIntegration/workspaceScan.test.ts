import { strict as assert } from 'node:assert'

import {
  commands,
  ConfigurationTarget,
  DiagnosticSeverity,
  languages,
  Range,
  Uri,
  window,
  WorkspaceEdit,
  workspace
} from 'vscode'

import type { WorkspaceScanResult } from '../../src/workspaceScan.js'

suite('fresh workspace scan integration', () => {
  test('scans closed files with real providers and unsaved text even with CodeLens disabled', async () => {
    const folder = workspace.workspaceFolders?.[0]

    assert.ok(folder !== undefined)

    const root = Uri.joinPath(folder.uri, 'scan')
    const typescriptUri = Uri.joinPath(root, 'closed-ts.ts')
    const javascriptUri = Uri.joinPath(root, 'closed-js.js')
    const isJavascriptDocumentOpen = workspace.textDocuments.some(document => document.uri.toString() === javascriptUri.toString())

    assert.equal(isJavascriptDocumentOpen, false)

    const configuration = workspace.getConfiguration('zeroReference')
    const previous = configuration.inspect('useCodeLens')?.workspaceValue
    const previousExclusions = configuration.inspect('exclude')?.workspaceValue
    const document = await workspace.openTextDocument(typescriptUri)
    const original = document.getText()
    const tabs = window.tabGroups.all.flatMap(group => group.tabs).length

    try {
      await configuration.update('useCodeLens', false, ConfigurationTarget.Workspace)
      await configuration.update('exclude', ['scan/consumer.ts'], ConfigurationTarget.Workspace)

      const edit = new WorkspaceEdit()
      const end = document.positionAt(original.length)

      edit.insert(typescriptUri, end, '\nscanUnusedTs();\n')
      assert.equal(await workspace.applyEdit(edit), true)

      const result = await commands.executeCommand<WorkspaceScanResult>('zeroReference.scanWorkspace')

      assert.ok(result !== undefined)
      assert.ok(result.status === 'complete' || result.status === 'incomplete')
      assert.equal(window.tabGroups.all.flatMap(group => group.tabs).length, tabs)
      assert.equal(document.isDirty, true)

      const file = await workspace.fs.readFile(typescriptUri)

      assert.equal(Buffer.from(file).toString(), original)

      const typescriptFindings = languages.getDiagnostics(typescriptUri).filter(item => item.source === 'Zero Reference')

      assert.equal(typescriptFindings.some(item => item.message.includes('scanUnusedTs')), false)
      assert.equal(typescriptFindings.some(item => item.message.includes('scanUsedTs')), false)

      for (const [extension, name] of [['tsx', 'Tsx'], ['mts', 'Mts'], ['cts', 'Cts'], ['js', 'Js'], ['jsx', 'Jsx'], ['mjs', 'Mjs'], ['cjs', 'Cjs']]) {
        const uri = Uri.joinPath(root, `closed-${extension}.${extension}`)
        const finding = languages.getDiagnostics(uri).find(item => item.source === 'Zero Reference' && item.message.includes(`scanUnused${name}`))

        assert.ok(finding !== undefined, `missing scan finding in ${extension}`)

        const target = await workspace.openTextDocument(uri)

        assert.equal(target.getText(finding.range), `scanUnused${name}`)
        assert.equal(finding.severity, DiagnosticSeverity.Information)
      }

      await commands.executeCommand('zeroReference.clearWorkspaceScanResults')
      assert.equal(languages.getDiagnostics(javascriptUri).some(item => item.source === 'Zero Reference'), false)
    } finally {
      await commands.executeCommand('zeroReference.clearWorkspaceScanResults')
      await configuration.update('useCodeLens', previous, ConfigurationTarget.Workspace)
      await configuration.update('exclude', previousExclusions, ConfigurationTarget.Workspace)

      const restore = new WorkspaceEdit()

      restore.replace(typescriptUri, new Range(0, 0, document.lineCount, 0), original)
      await workspace.applyEdit(restore)
    }
  })

})
