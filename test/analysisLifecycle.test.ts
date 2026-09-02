import { strict as assert } from 'node:assert'

import {
  CancellationTokenSource,
  DocumentSymbol,
  Location,
  Position,
  Range,
  SymbolKind,
  Uri,
  WorkspaceEdit,
  workspace
} from 'vscode'

import { ZeroReferenceAnalyzer } from '../src/analysis.js'
import type { CommandExecutor } from '../src/analysis.js'
import { registerAnalysisLifecycle } from '../src/analysisLifecycle.js'

suite('analysis lifecycle', () => {
  test('invalidates supported filesystem changes and directory deletion', async () => {
    const workspaceFolder = workspace.workspaceFolders?.[0]

    assert.ok(workspaceFolder !== undefined)

    const uniqueSuffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`

    const supportedUri = Uri.joinPath(
      workspaceFolder.uri,
      `.zero-reference-lifecycle-${uniqueSuffix}.ts`
    )

    const renamedUri = Uri.joinPath(
      workspaceFolder.uri,
      `.zero-reference-lifecycle-${uniqueSuffix}.txt`
    )

    const unsupportedUri = Uri.joinPath(
      workspaceFolder.uri,
      `.zero-reference-unsupported-${uniqueSuffix}.txt`
    )

    const directoryUri = Uri.joinPath(
      workspaceFolder.uri,
      `.zero-reference-directory-${uniqueSuffix}`
    )

    const nestedUri = Uri.joinPath(directoryUri, 'nested.ts')
    const executeCommand: CommandExecutor = async <Result>() => [] as Result
    const analyzer = new ZeroReferenceAnalyzer(executeCommand)
    const lifecycle = registerAnalysisLifecycle(analyzer)
    let invalidationCount = 0

    const subscription = analyzer.onDidInvalidate(() => {
      invalidationCount += 1
    })

    try {
      let previousInvalidationCount = invalidationCount

      await workspace.fs.writeFile(
        supportedUri,
        Buffer.from('export const value = 1;\n')
      )

      await waitUntil(() => invalidationCount > previousInvalidationCount)
      await delay(50)
      previousInvalidationCount = invalidationCount

      await workspace.fs.writeFile(
        supportedUri,
        Buffer.from('export const value = 2;\n')
      )

      await waitUntil(() => invalidationCount > previousInvalidationCount)
      await delay(50)
      previousInvalidationCount = invalidationCount

      await workspace.fs.rename(supportedUri, renamedUri)
      await waitUntil(() => invalidationCount > previousInvalidationCount)
      await delay(50)
      previousInvalidationCount = invalidationCount

      await workspace.fs.rename(renamedUri, supportedUri)
      await waitUntil(() => invalidationCount > previousInvalidationCount)
      await delay(50)
      previousInvalidationCount = invalidationCount

      await workspace.fs.writeFile(
        unsupportedUri,
        Buffer.from('unsupported\n')
      )

      await delay(100)
      assert.equal(invalidationCount, previousInvalidationCount)

      await workspace.fs.createDirectory(directoryUri)
      await waitUntil(() => invalidationCount > previousInvalidationCount)
      await delay(50)
      previousInvalidationCount = invalidationCount

      await workspace.fs.writeFile(
        nestedUri,
        Buffer.from('export const nested = true;\n')
      )

      await waitUntil(() => invalidationCount > previousInvalidationCount)
      await delay(50)
      previousInvalidationCount = invalidationCount

      await workspace.fs.delete(directoryUri, { recursive: true })
      await waitUntil(() => invalidationCount > previousInvalidationCount)
      await delay(50)
      previousInvalidationCount = invalidationCount

      await workspace.fs.delete(supportedUri)
      await waitUntil(() => invalidationCount > previousInvalidationCount)
    } finally {
      subscription.dispose()
      lifecycle.dispose()
      analyzer.dispose()
      await deleteIfPresent(supportedUri)
      await deleteIfPresent(renamedUri)
      await deleteIfPresent(unsupportedUri)
      await deleteIfPresent(directoryUri)
    }
  })

  test('invalidates cached findings after an unsaved cross-document edit', async () => {
    const declarationDocument = await workspace.openTextDocument({
      content: 'export const value = 1;\n',
      language: 'typescript'
    })

    const consumerDocument = await workspace.openTextDocument({
      content: '',
      language: 'typescript'
    })

    const declarationRange = new Range(0, 13, 0, 18)

    const declarationSymbol = new DocumentSymbol(
      'value',
      '',
      SymbolKind.Variable,
      new Range(0, 0, 0, 23),
      declarationRange
    )

    let hasConsumerReference = false
    let documentSymbolCalls = 0
    let referenceCalls = 0

    const executeCommand: CommandExecutor = async <Result>(
      command: string
    ): Promise<Result | undefined> => {
      if (command === 'vscode.executeDocumentSymbolProvider') {
        documentSymbolCalls += 1

        return [declarationSymbol] as Result
      }

      referenceCalls += 1

      const locations = [
        new Location(declarationDocument.uri, declarationRange)
      ]

      if (hasConsumerReference) {
        locations.push(new Location(consumerDocument.uri, new Range(0, 0, 0, 5)))
      }

      return locations as Result
    }

    const analyzer = new ZeroReferenceAnalyzer(executeCommand)
    const lifecycle = registerAnalysisLifecycle(analyzer)
    const tokenSource = new CancellationTokenSource()
    let invalidationCount = 0

    const subscription = analyzer.onDidInvalidate(() => {
      invalidationCount += 1
    })

    try {
      const initialResult = await analyzer.analyze(
        declarationDocument,
        tokenSource.token
      )

      assert.deepEqual(initialResult.map(finding => finding.name), ['value'])

      hasConsumerReference = true

      const addReference = new WorkspaceEdit()

      addReference.insert(consumerDocument.uri, new Position(0, 0), 'value')
      assert.equal(await workspace.applyEdit(addReference), true)
      await waitUntil(() => invalidationCount > 0)

      const refreshedResult = await analyzer.analyze(
        declarationDocument,
        tokenSource.token
      )

      assert.deepEqual(refreshedResult, [])
      assert.equal(documentSymbolCalls, 2)
      assert.equal(referenceCalls, 2)
    } finally {
      subscription.dispose()
      lifecycle.dispose()
      analyzer.dispose()
      tokenSource.dispose()
    }
  })
})

async function deleteIfPresent(uri: Uri): Promise<void> {
  try {
    await workspace.fs.delete(uri, { recursive: true })
  } catch {
    // The test may already have deleted or renamed the temporary resource.
  }
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const timeoutAt = Date.now() + 2_000

  while (!predicate()) {
    assert.ok(Date.now() < timeoutAt, 'timed out waiting for workspace event')
    await delay(10)
  }
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>(resolve => {
    setTimeout(resolve, milliseconds)
  })
}
