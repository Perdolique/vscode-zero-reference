import { strict as assert } from 'node:assert';
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
} from 'vscode';
import {
  ZeroReferenceCodeLensProvider
} from '../src/codeLensProvider.js';
import type { CommandExecutor } from '../src/codeLensProvider.js';

suite('ZeroReferenceCodeLensProvider', () => {
  test('rejects absent, empty, external, and unknown reference results', async () => {
    const fixture = await createSymbolFixture(1);
    const declaration = new Location(
      fixture.document.uri,
      fixture.declarationRanges[0] ?? new Range(0, 0, 0, 0)
    );
    const cases: readonly (readonly [string, unknown])[] = [
      ['undefined', undefined],
      ['empty', []],
      ['external URI', [new Location(Uri.file('/outside.ts'), declaration.range)]],
      ['unknown range', [new Location(fixture.document.uri, new Range(0, 0, 0, 1))]]
    ];

    for (const [label, references] of cases) {
      const provider = createProvider(fixture.symbols, () => references);
      const tokenSource = new CancellationTokenSource();
      const result = await provider.provideCodeLenses(fixture.document, tokenSource.token);

      assert.deepEqual(result, [], label);
      provider.dispose();
      tokenSource.dispose();
    }
  });

  test('logs reference errors once and creates no lenses', async () => {
    const fixture = await createSymbolFixture(6);
    const error = new Error('reference provider failed');
    const loggedErrors: unknown[] = [];
    const originalConsoleError = console.error;
    const provider = createProvider(fixture.symbols, () => {
      throw error;
    });

    Object.defineProperty(console, 'error', {
      configurable: true,
      value: (loggedError: unknown): void => {
        loggedErrors.push(loggedError);
      }
    });

    try {
      const result = await provider.provideCodeLenses(
        fixture.document,
        new CancellationTokenSource().token
      );

      assert.deepEqual(result, []);
      assert.deepEqual(loggedErrors, [error]);
    } finally {
      Object.defineProperty(console, 'error', {
        configurable: true,
        value: originalConsoleError
      });
      provider.dispose();
    }
  });

  test('creates one lens only for declaration-only locations', async () => {
    const fixture = await createSymbolFixture(1);
    const declarationRange = fixture.declarationRanges[0];

    assert.ok(declarationRange !== undefined);

    const provider = createProvider(
      fixture.symbols,
      () => [new Location(fixture.document.uri, declarationRange)]
    );
    const result = await provider.provideCodeLenses(
      fixture.document,
      new CancellationTokenSource().token
    );

    assert.equal(result.length, 1);
    assert.equal(result[0]?.command?.title, '"f0" has zero references');
    provider.dispose();
  });

  test('rejects used symbols and recursive self-calls', async () => {
    const fixture = await createSymbolFixture(2);
    const provider = createProvider(fixture.symbols, position => {
      const declarationRange = fixture.declarationRanges[position.line];

      assert.ok(declarationRange !== undefined);

      return [
        new Location(fixture.document.uri, declarationRange),
        new Location(fixture.document.uri, new Range(position.line, 20, position.line, 22))
      ];
    });
    const result = await provider.provideCodeLenses(
      fixture.document,
      new CancellationTokenSource().token
    );

    assert.deepEqual(result, []);
    provider.dispose();
  });

  test('deduplicates same-file overload and merged declaration groups', async () => {
    const fixture = await createNamedSymbolFixture([
      'overloaded',
      'overloaded',
      'overloaded',
      'MergedModel',
      'MergedModel'
    ]);
    const firstGroup = fixture.declarationRanges.slice(0, 3);
    const secondGroup = fixture.declarationRanges.slice(3);
    const provider = createProvider(fixture.symbols, position => {
      const ranges = position.line < 3 ? firstGroup : secondGroup;

      return ranges.map(range => new Location(fixture.document.uri, range));
    });
    const result = await provider.provideCodeLenses(
      fixture.document,
      new CancellationTokenSource().token
    );

    assert.deepEqual(
      result.map(codeLens => codeLens.command?.title),
      ['"overloaded" has zero references', '"MergedModel" has zero references']
    );
    provider.dispose();
  });

  test('rejects an entire declaration group when it has an external reference', async () => {
    const fixture = await createSymbolFixture(3);
    const provider = createProvider(fixture.symbols, () => [
      ...fixture.declarationRanges.map(range => new Location(fixture.document.uri, range)),
      new Location(Uri.file('/consumer.ts'), new Range(0, 0, 0, 2))
    ]);
    const result = await provider.provideCodeLenses(
      fixture.document,
      new CancellationTokenSource().token
    );

    assert.deepEqual(result, []);
    provider.dispose();
  });

  test('does not guess a computed member after an unresolved lookup', async () => {
    const document = await workspace.openTextDocument({
      content: 'class Example { ["literal"](): void {} }\nnew Example()["literal"]();',
      language: 'typescript'
    });
    const nameRange = new Range(0, 16, 0, 27);
    const symbol = new DocumentSymbol(
      '["literal"]',
      '',
      SymbolKind.Method,
      new Range(0, 0, 0, 41),
      nameRange
    );
    const provider = createProvider([symbol], () => []);
    const result = await provider.provideCodeLenses(
      document,
      new CancellationTokenSource().token
    );

    assert.deepEqual(result, []);
    provider.dispose();
  });

  test('shares four lookup slots across documents and preserves symbol order', async () => {
    const firstFixture = await createSymbolFixture(10);
    const secondFixture = await createSymbolFixture(10);
    let activeLookups = 0;
    let maximumActiveLookups = 0;
    const provider = createProvider(firstFixture.symbols, async (position, uri) => {
      activeLookups += 1;
      maximumActiveLookups = Math.max(maximumActiveLookups, activeLookups);

      await delay((10 - position.line) % 4);

      activeLookups -= 1;
      const declarationRange = firstFixture.declarationRanges[position.line];

      assert.ok(declarationRange !== undefined);
      return [new Location(uri, declarationRange)];
    });
    const tokenSource = new CancellationTokenSource();
    const results = await Promise.all([
      provider.provideCodeLenses(firstFixture.document, tokenSource.token),
      provider.provideCodeLenses(secondFixture.document, tokenSource.token)
    ]);
    const expectedTitles = Array.from(
      { length: 10 },
      (_, index) => `"f${index}" has zero references`
    );

    assert.equal(maximumActiveLookups, 4);
    assert.deepEqual(results.map(result =>
      result.map(codeLens => codeLens.command?.title)
    ), [expectedTitles, expectedTitles]);
    provider.dispose();
    tokenSource.dispose();
  });

  test('does not dequeue more symbols after cancellation', async () => {
    const fixture = await createSymbolFixture(10);
    const tokenSource = new CancellationTokenSource();
    const gate = createDeferred<void>();
    let referenceCalls = 0;
    const provider = createProvider(fixture.symbols, async position => {
      referenceCalls += 1;
      await gate.promise;

      const declarationRange = fixture.declarationRanges[position.line];

      assert.ok(declarationRange !== undefined);
      return [new Location(fixture.document.uri, declarationRange)];
    });
    const resultPromise = provider.provideCodeLenses(fixture.document, tokenSource.token);

    await waitUntil(() => referenceCalls === 4);
    tokenSource.cancel();
    gate.resolve();

    assert.deepEqual(await resultPromise, []);
    assert.equal(referenceCalls, 4);
    provider.dispose();
    tokenSource.dispose();
  });

  test('discards a deferred lookup when refresh advances the generation', async () => {
    const fixture = await createSymbolFixture(1);
    const declarationRange = fixture.declarationRanges[0];

    assert.ok(declarationRange !== undefined);

    const gate = createDeferred<void>();
    const lookupStarted = createDeferred<void>();
    const provider = createProvider(fixture.symbols, async () => {
      lookupStarted.resolve();
      await gate.promise;
      return [new Location(fixture.document.uri, declarationRange)];
    });
    const resultPromise = provider.provideCodeLenses(
      fixture.document,
      new CancellationTokenSource().token
    );

    await lookupStarted.promise;
    provider.refresh();
    gate.resolve();

    assert.deepEqual(await resultPromise, []);
    provider.dispose();
  });

  test('discards a deferred lookup after the document changes', async () => {
    const fixture = await createSymbolFixture(1);
    const declarationRange = fixture.declarationRanges[0];

    assert.ok(declarationRange !== undefined);

    const gate = createDeferred<void>();
    const lookupStarted = createDeferred<void>();
    const provider = createProvider(fixture.symbols, async () => {
      lookupStarted.resolve();
      await gate.promise;
      return [new Location(fixture.document.uri, declarationRange)];
    });
    const tokenSource = new CancellationTokenSource();
    const initialVersion = fixture.document.version;
    const resultPromise = provider.provideCodeLenses(
      fixture.document,
      tokenSource.token
    );

    await lookupStarted.promise;

    const edit = new WorkspaceEdit();

    edit.insert(fixture.document.uri, new Position(0, 0), ' ');
    assert.equal(await workspace.applyEdit(edit), true);
    assert.ok(fixture.document.version > initialVersion);
    gate.resolve();

    assert.deepEqual(await resultPromise, []);
    provider.dispose();
    tokenSource.dispose();
  });
});

interface SymbolFixture {
  readonly document: Awaited<ReturnType<typeof workspace.openTextDocument>>;
  readonly symbols: readonly DocumentSymbol[];
  readonly declarationRanges: readonly Range[];
}

async function createSymbolFixture(count: number): Promise<SymbolFixture> {
  const names = Array.from({ length: count }, (_, index) => `f${index}`);

  return createNamedSymbolFixture(names);
}

async function createNamedSymbolFixture(
  names: readonly string[]
): Promise<SymbolFixture> {
  const lines = names.map(name => `function ${name}() {}`);
  const document = await workspace.openTextDocument({
    content: lines.join('\n'),
    language: 'typescript'
  });
  const declarationRanges = names.map((name, index) =>
    new Range(index, 9, index, 9 + name.length)
  );
  const symbols = names.map((name, index) => new DocumentSymbol(
    name,
    '',
    SymbolKind.Function,
    new Range(index, 0, index, lines[index]?.length ?? 0),
    declarationRanges[index] ?? new Range(index, 0, index, 0)
  ));

  return { document, symbols, declarationRanges };
}

function createProvider(
  symbols: readonly DocumentSymbol[],
  getReferences: (position: Position, uri: Uri) => unknown | Promise<unknown>
): ZeroReferenceCodeLensProvider {
  const executeCommand: CommandExecutor = async <Result>(
    command: string,
    ...args: readonly unknown[]
  ): Promise<Result | undefined> => {
    if (command === 'vscode.executeDocumentSymbolProvider') {
      return symbols as Result;
    }

    const uri = args[0];
    const position = args[1];

    assert.ok(uri instanceof Uri);
    assert.ok(position instanceof Position);
    return await getReferences(position, uri) as Result;
  };

  return new ZeroReferenceCodeLensProvider(executeCommand, () => true);
}

interface Deferred<Value> {
  readonly promise: Promise<Value>;
  readonly resolve: (value: Value) => void;
}

function createDeferred<Value>(): Deferred<Value> {
  let resolvePromise: ((value: Value) => void) | undefined;
  const promise = new Promise<Value>(resolve => {
    resolvePromise = resolve;
  });

  assert.ok(resolvePromise !== undefined);
  return { promise, resolve: resolvePromise };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  while (!predicate()) {
    await delay(0);
  }
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>(resolve => {
    setTimeout(resolve, milliseconds);
  });
}
