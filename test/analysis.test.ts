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

suite('ZeroReferenceAnalyzer', () => {
  test('reuses a completed analysis with the same identity', async () => {
    const fixture = await createSymbolFixture(2)

    const harness = createAnalyzerHarness(fixture, position => {
      const declarationRange = fixture.declarationRanges[position.line]

      assert.ok(declarationRange !== undefined)

      return [new Location(fixture.document.uri, declarationRange)]
    })

    const tokenSource = new CancellationTokenSource()

    const firstResult = await harness.analyzer.analyze(
      fixture.document,
      tokenSource.token
    )

    const secondResult = await harness.analyzer.analyze(
      fixture.document,
      tokenSource.token
    )

    assert.deepEqual(firstResult.map(finding => finding.name), ['f0', 'f1'])
    assert.equal(secondResult, firstResult)

    assert.deepEqual(harness.counts, {
      documentSymbolCalls: 1,
      referenceCalls: 2
    })

    assert.ok(firstResult[0]?.declarationRange.isEqual(
      fixture.declarationRanges[0] ?? new Range(0, 0, 0, 0)
    ))

    harness.analyzer.dispose()
    tokenSource.dispose()
  })

  test('graph and configuration invalidation refresh and rerun analysis', async () => {
    const fixture = await createSymbolFixture(1)

    const harness = createAnalyzerHarness(fixture, position => {
      const declarationRange = fixture.declarationRanges[position.line]

      assert.ok(declarationRange !== undefined)

      return [new Location(fixture.document.uri, declarationRange)]
    })

    const tokenSource = new CancellationTokenSource()
    let invalidationCount = 0

    const subscription = harness.analyzer.onDidInvalidate(() => {
      invalidationCount += 1
    })

    await harness.analyzer.analyze(fixture.document, tokenSource.token)
    harness.analyzer.invalidateGraph()
    await harness.analyzer.analyze(fixture.document, tokenSource.token)
    harness.analyzer.invalidateConfiguration()
    await harness.analyzer.analyze(fixture.document, tokenSource.token)

    assert.equal(invalidationCount, 2)

    assert.deepEqual(harness.counts, {
      documentSymbolCalls: 3,
      referenceCalls: 3
    })

    subscription.dispose()
    harness.analyzer.dispose()
    tokenSource.dispose()
  })

  test('document version changes rerun analysis without emitting invalidation', async () => {
    const fixture = await createSymbolFixture(1)

    const harness = createAnalyzerHarness(fixture, position => {
      const declarationRange = fixture.declarationRanges[position.line]

      assert.ok(declarationRange !== undefined)

      return [new Location(fixture.document.uri, declarationRange)]
    })

    const tokenSource = new CancellationTokenSource()
    let invalidationCount = 0

    const subscription = harness.analyzer.onDidInvalidate(() => {
      invalidationCount += 1
    })

    await harness.analyzer.analyze(fixture.document, tokenSource.token)

    const edit = new WorkspaceEdit()
    const endPosition = fixture.document.positionAt(fixture.document.getText().length)

    edit.insert(fixture.document.uri, endPosition, '\n')
    assert.equal(await workspace.applyEdit(edit), true)
    await harness.analyzer.analyze(fixture.document, tokenSource.token)

    assert.equal(invalidationCount, 0)

    assert.deepEqual(harness.counts, {
      documentSymbolCalls: 2,
      referenceCalls: 2
    })

    subscription.dispose()
    harness.analyzer.dispose()
    tokenSource.dispose()
  })

  test('explicit eviction preserves another document cached analysis', async () => {
    const firstFixture = await createSymbolFixture(1)
    const secondFixture = await createSymbolFixture(1)

    const harness = createAnalyzerHarness(firstFixture, (position, uri) => {
      const declarationRange = firstFixture.declarationRanges[position.line]

      assert.ok(declarationRange !== undefined)

      return [new Location(uri, declarationRange)]
    })

    const tokenSource = new CancellationTokenSource()

    const firstResult = await harness.analyzer.analyze(
      firstFixture.document,
      tokenSource.token
    )

    const secondResult = await harness.analyzer.analyze(
      secondFixture.document,
      tokenSource.token
    )

    harness.analyzer.forgetDocument(firstFixture.document.uri)

    const refreshedFirstResult = await harness.analyzer.analyze(
      firstFixture.document,
      tokenSource.token
    )

    const cachedSecondResult = await harness.analyzer.analyze(
      secondFixture.document,
      tokenSource.token
    )

    assert.notEqual(refreshedFirstResult, firstResult)
    assert.equal(cachedSecondResult, secondResult)

    assert.deepEqual(harness.counts, {
      documentSymbolCalls: 3,
      referenceCalls: 3
    })

    harness.analyzer.dispose()
    tokenSource.dispose()
  })

  test('does not cache a cancelled analysis', async () => {
    const fixture = await createSymbolFixture(1)
    const gate = createDeferred<void>()
    const lookupStarted = createDeferred<void>()

    const harness = createAnalyzerHarness(fixture, async position => {
      lookupStarted.resolve()
      await gate.promise

      const declarationRange = fixture.declarationRanges[position.line]

      assert.ok(declarationRange !== undefined)

      return [new Location(fixture.document.uri, declarationRange)]
    })

    const cancelledTokenSource = new CancellationTokenSource()

    const resultPromise = harness.analyzer.analyze(
      fixture.document,
      cancelledTokenSource.token
    )

    await lookupStarted.promise
    cancelledTokenSource.cancel()
    gate.resolve()

    assert.deepEqual(await resultPromise, [])

    const retryTokenSource = new CancellationTokenSource()

    const retryResult = await harness.analyzer.analyze(
      fixture.document,
      retryTokenSource.token
    )

    assert.deepEqual(retryResult.map(finding => finding.name), ['f0'])

    assert.deepEqual(harness.counts, {
      documentSymbolCalls: 2,
      referenceCalls: 2
    })

    cancelledTokenSource.dispose()
    retryTokenSource.dispose()
    harness.analyzer.dispose()
  })

  test('removes a cancelled analysis from the pending lookup queue', async () => {
    const activeFixture = await createSymbolFixture(4)
    const queuedFixture = await createSymbolFixture(4)
    const activeGate = createDeferred<void>()

    const harness = createAnalyzerHarness(activeFixture, async (position, uri) => {
      assert.notEqual(uri.toString(), queuedFixture.document.uri.toString())
      await activeGate.promise

      const declarationRange = activeFixture.declarationRanges[position.line]

      assert.ok(declarationRange !== undefined)

      return [new Location(uri, declarationRange)]
    })

    const activeTokenSource = new CancellationTokenSource()
    const queuedTokenSource = new CancellationTokenSource()

    const activeAnalysis = harness.analyzer.analyze(
      activeFixture.document,
      activeTokenSource.token
    )

    await waitUntil(() => harness.counts.referenceCalls === 4)

    const queuedAnalysis = harness.analyzer.analyze(
      queuedFixture.document,
      queuedTokenSource.token
    )

    await waitUntil(() => harness.counts.documentSymbolCalls === 2)
    await delay(0)

    let hasQueuedAnalysisCompleted = false

    const queuedCompletion = queuedAnalysis.then(result => {
      hasQueuedAnalysisCompleted = true

      return result
    })

    queuedTokenSource.cancel()
    await delay(250)

    const completedBeforeRelease = hasQueuedAnalysisCompleted

    activeGate.resolve()

    const [activeResult, queuedResult] = await Promise.all([
      activeAnalysis,
      queuedCompletion
    ])

    assert.equal(completedBeforeRelease, true)
    assert.deepEqual(queuedResult, [])
    assert.deepEqual(activeResult.map(finding => finding.name), ['f0', 'f1', 'f2', 'f3'])
    assert.equal(harness.counts.referenceCalls, 4)

    harness.analyzer.dispose()
    activeTokenSource.dispose()
    queuedTokenSource.dispose()
  })

  test('does not cache an analysis with a reference provider error', async () => {
    const fixture = await createSymbolFixture(1)
    const providerError = new Error('temporary provider failure')
    let shouldFail = true

    const harness = createAnalyzerHarness(fixture, position => {
      if (shouldFail) {
        shouldFail = false
        throw providerError
      }

      const declarationRange = fixture.declarationRanges[position.line]

      assert.ok(declarationRange !== undefined)

      return [new Location(fixture.document.uri, declarationRange)]
    })

    const loggedErrors: unknown[] = []
    const originalConsoleError = console.error

    Object.defineProperty(console, 'error', {
      configurable: true,

      value: (error: unknown): void => {
        loggedErrors.push(error)
      }
    })

    try {
      const tokenSource = new CancellationTokenSource()

      const firstResult = await harness.analyzer.analyze(
        fixture.document,
        tokenSource.token
      )

      const secondResult = await harness.analyzer.analyze(
        fixture.document,
        tokenSource.token
      )

      assert.deepEqual(firstResult, [])
      assert.deepEqual(secondResult.map(finding => finding.name), ['f0'])
      assert.deepEqual(loggedErrors, [providerError])

      assert.deepEqual(harness.counts, {
        documentSymbolCalls: 2,
        referenceCalls: 2
      })

      tokenSource.dispose()
    } finally {
      Object.defineProperty(console, 'error', {
        configurable: true,
        value: originalConsoleError
      })

      harness.analyzer.dispose()
    }
  })

  test('logs and retries a document symbol provider error', async () => {
    const fixture = await createSymbolFixture(1)
    const providerError = new Error('temporary document symbol provider failure')
    const loggedErrors: unknown[] = []
    const originalConsoleError = console.error
    let documentSymbolCalls = 0
    let referenceCalls = 0

    const executeCommand: CommandExecutor = async <Result>(
      command: string,
      ...args: readonly unknown[]
    ): Promise<Result | undefined> => {
      if (command === 'vscode.executeDocumentSymbolProvider') {
        documentSymbolCalls += 1

        if (documentSymbolCalls === 1) {
          throw providerError
        }

        return fixture.symbols as Result
      }

      referenceCalls += 1

      const uri = args[0]
      const position = args[1]

      assert.ok(uri instanceof Uri)
      assert.ok(position instanceof Position)

      const declarationRange = fixture.declarationRanges[position.line]

      assert.ok(declarationRange !== undefined)

      return [new Location(uri, declarationRange)] as Result
    }

    const analyzer = new ZeroReferenceAnalyzer(executeCommand)
    const tokenSource = new CancellationTokenSource()

    Object.defineProperty(console, 'error', {
      configurable: true,

      value: (error: unknown): void => {
        loggedErrors.push(error)
      }
    })

    try {
      const firstResult = await analyzer.analyze(
        fixture.document,
        tokenSource.token
      )

      const secondResult = await analyzer.analyze(
        fixture.document,
        tokenSource.token
      )

      assert.deepEqual(firstResult, [])
      assert.deepEqual(secondResult.map(finding => finding.name), ['f0'])
      assert.deepEqual(loggedErrors, [providerError])
      assert.equal(documentSymbolCalls, 2)
      assert.equal(referenceCalls, 1)
    } finally {
      Object.defineProperty(console, 'error', {
        configurable: true,
        value: originalConsoleError
      })

      analyzer.dispose()
      tokenSource.dispose()
    }
  })

  test('discards stale work after configuration invalidation', async () => {
    const fixture = await createSymbolFixture(1)
    const gate = createDeferred<void>()
    const lookupStarted = createDeferred<void>()

    const harness = createAnalyzerHarness(fixture, async position => {
      lookupStarted.resolve()
      await gate.promise

      const declarationRange = fixture.declarationRanges[position.line]

      assert.ok(declarationRange !== undefined)

      return [new Location(fixture.document.uri, declarationRange)]
    })

    const tokenSource = new CancellationTokenSource()

    const staleResultPromise = harness.analyzer.analyze(
      fixture.document,
      tokenSource.token
    )

    await lookupStarted.promise
    harness.analyzer.invalidateConfiguration()
    gate.resolve()

    assert.deepEqual(await staleResultPromise, [])

    const retryResult = await harness.analyzer.analyze(
      fixture.document,
      tokenSource.token
    )

    assert.deepEqual(retryResult.map(finding => finding.name), ['f0'])

    assert.deepEqual(harness.counts, {
      documentSymbolCalls: 2,
      referenceCalls: 2
    })

    harness.analyzer.dispose()
    tokenSource.dispose()
  })

  test('discards stale work after graph invalidation and disposal', async () => {
    const fixture = await createSymbolFixture(1)
    const firstGate = createDeferred<void>()
    const secondGate = createDeferred<void>()
    const firstLookupStarted = createDeferred<void>()
    const secondLookupStarted = createDeferred<void>()
    let referenceCall = 0

    const harness = createAnalyzerHarness(fixture, async position => {
      referenceCall += 1

      if (referenceCall === 1) {
        firstLookupStarted.resolve()
        await firstGate.promise
      } else {
        secondLookupStarted.resolve()
        await secondGate.promise
      }

      const declarationRange = fixture.declarationRanges[position.line]

      assert.ok(declarationRange !== undefined)

      return [new Location(fixture.document.uri, declarationRange)]
    })

    const tokenSource = new CancellationTokenSource()

    const staleResultPromise = harness.analyzer.analyze(
      fixture.document,
      tokenSource.token
    )

    await firstLookupStarted.promise
    harness.analyzer.invalidateGraph()
    firstGate.resolve()
    assert.deepEqual(await staleResultPromise, [])

    const disposedResultPromise = harness.analyzer.analyze(
      fixture.document,
      tokenSource.token
    )

    await secondLookupStarted.promise
    harness.analyzer.dispose()
    secondGate.resolve()

    assert.deepEqual(await disposedResultPromise, [])

    assert.deepEqual(harness.counts, {
      documentSymbolCalls: 2,
      referenceCalls: 2
    })

    tokenSource.dispose()
  })
})

interface AnalyzerCounts {
  documentSymbolCalls: number;
  referenceCalls: number;
}

interface AnalyzerHarness {
  readonly analyzer: ZeroReferenceAnalyzer;
  readonly counts: AnalyzerCounts;
}

interface SymbolFixture {
  readonly declarationRanges: readonly Range[];
  readonly document: Awaited<ReturnType<typeof workspace.openTextDocument>>;
  readonly symbols: readonly DocumentSymbol[];
}

async function createSymbolFixture(count: number): Promise<SymbolFixture> {
  const names = Array.from({ length: count }, (_, index) => `f${index}`)
  const lines = names.map(name => `function ${name}() {}`)

  const document = await workspace.openTextDocument({
    content: lines.join('\n'),
    language: 'typescript'
  })

  const declarationRanges = names.map((name, index) =>
    new Range(index, 9, index, 9 + name.length)
  )

  const symbols = names.map((name, index) => new DocumentSymbol(
    name,
    '',
    SymbolKind.Function,
    new Range(index, 0, index, lines[index]?.length ?? 0),
    declarationRanges[index] ?? new Range(index, 0, index, 0)
  ))

  return {
    declarationRanges,
    document,
    symbols
  }
}

function createAnalyzerHarness(
  fixture: SymbolFixture,
  getReferences: (position: Position, uri: Uri) => unknown | Promise<unknown>
): AnalyzerHarness {
  const counts: AnalyzerCounts = {
    documentSymbolCalls: 0,
    referenceCalls: 0
  }

  const executeCommand: CommandExecutor = async <Result>(
    command: string,
    ...args: readonly unknown[]
  ): Promise<Result | undefined> => {
    if (command === 'vscode.executeDocumentSymbolProvider') {
      counts.documentSymbolCalls += 1

      return fixture.symbols as Result
    }

    counts.referenceCalls += 1

    const uri = args[0]
    const position = args[1]

    assert.ok(uri instanceof Uri)
    assert.ok(position instanceof Position)

    return await getReferences(position, uri) as Result
  }

  const analyzer = new ZeroReferenceAnalyzer(executeCommand)

  return {
    analyzer,
    counts
  }
}

interface Deferred<Value> {
  readonly promise: Promise<Value>;
  readonly resolve: (value: Value) => void;
}

function createDeferred<Value>(): Deferred<Value> {
  let resolvePromise: ((value: Value) => void) | undefined

  const promise = new Promise<Value>(resolve => {
    resolvePromise = resolve
  })

  assert.ok(resolvePromise !== undefined)

  return {
    promise,
    resolve: resolvePromise
  }
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const timeoutAt = Date.now() + 2_000

  while (!predicate()) {
    assert.ok(Date.now() < timeoutAt, 'timed out waiting for analysis state')
    await delay(10)
  }
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>(resolve => {
    setTimeout(resolve, milliseconds)
  })
}
