import { strict as assert } from 'node:assert';
import {
  DocumentSymbol,
  Location,
  Position,
  Range,
  SymbolInformation,
  SymbolKind,
  workspace
} from 'vscode';
import { getSymbolData } from '../src/symbols.js';

suite('symbol classification', () => {
  test('preserves preorder across nested and unsupported symbols', async () => {
    const document = await workspace.openTextDocument({
      content: 'root child nested sibling info',
      language: 'typescript'
    });
    const root = createSymbol('root', SymbolKind.Function, 0, 4);
    const unsupportedChild = createSymbol('child', SymbolKind.String, 5, 10);
    const nested = createSymbol('nested', SymbolKind.Method, 11, 17);
    const sibling = createSymbol('sibling', SymbolKind.Variable, 18, 25);
    const information = new SymbolInformation(
      'info',
      SymbolKind.Interface,
      '',
      new Location(document.uri, range(26, 30))
    );

    unsupportedChild.children.push(nested);
    root.children.push(unsupportedChild, sibling);

    const result = getSymbolData([root, information], document);

    assert.deepEqual(result.map(symbol => symbol.name), [
      'root',
      'nested',
      'sibling',
      'info'
    ]);
    assert.ok(result[0]?.declarationRange.isEqual(range(0, 4)));
    assert.ok(result[3]?.declarationRange.isEqual(range(26, 30)));
  });

  test('walks a deep symbol tree without using the call stack', async () => {
    const document = await workspace.openTextDocument({
      content: 'node',
      language: 'typescript'
    });
    const root = createSymbol('node', SymbolKind.String, 0, 4);
    let parent = root;

    for (let index = 0; index < 20_000; index += 1) {
      const childKind = index === 19_999 ? SymbolKind.Method : SymbolKind.String;
      const child = createSymbol('node', childKind, 0, 4);

      parent.children.push(child);
      parent = child;
    }

    const result = getSymbolData([root], document);

    assert.equal(result.length, 1);
    assert.equal(result[0]?.name, 'node');
  });

  test('recovers exactly one normalized name from a full declaration range', async () => {
    const document = await workspace.openTextDocument({
      content: 'function foo(value: string): string;\nget value(): string;',
      language: 'typescript'
    });
    const overloadRange = new Range(0, 0, 0, 36);
    const overload = new DocumentSymbol(
      'foo',
      '',
      SymbolKind.Function,
      overloadRange,
      overloadRange
    );
    const getterRange = new Range(1, 0, 1, 20);
    const getter = new DocumentSymbol(
      '(get) value',
      '',
      SymbolKind.Property,
      getterRange,
      getterRange
    );

    const result = getSymbolData([overload, getter], document);

    assert.equal(result.length, 2);
    assert.ok(result[0]?.declarationRange.isEqual(new Range(0, 9, 0, 12)));
    assert.ok(result[1]?.declarationRange.isEqual(new Range(1, 4, 1, 9)));
  });

  test('omits a full declaration range with multiple name candidates', async () => {
    const document = await workspace.openTextDocument({
      content: 'function foo(foo: string): string;',
      language: 'typescript'
    });
    const declarationRange = new Range(0, 0, 0, 34);
    const symbol = new DocumentSymbol(
      'foo',
      '',
      SymbolKind.Function,
      declarationRange,
      declarationRange
    );

    assert.deepEqual(getSymbolData([symbol], document), []);
  });
});

function createSymbol(
  name: string,
  kind: SymbolKind,
  start: number,
  end: number
): DocumentSymbol {
  const symbolRange = range(start, end);

  return new DocumentSymbol(name, '', kind, symbolRange, symbolRange);
}

function range(start: number, end: number): Range {
  return new Range(new Position(0, start), new Position(0, end));
}
