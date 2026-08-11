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
      content: 'function foo(value: string): string;\nclass Example { get value(): string; }',
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
    const classSymbol = new DocumentSymbol(
      'Example',
      '',
      SymbolKind.Class,
      new Range(1, 0, 1, 38),
      new Range(1, 6, 1, 13)
    );
    const getterRange = new Range(1, 16, 1, 36);
    const getter = new DocumentSymbol(
      '(get) value',
      '',
      SymbolKind.Property,
      getterRange,
      getterRange
    );

    classSymbol.children.push(getter);

    const result = getSymbolData([overload, classSymbol], document);

    assert.equal(result.length, 3);
    assert.ok(result[0]?.declarationRange.isEqual(new Range(0, 9, 0, 12)));
    assert.ok(result[2]?.declarationRange.isEqual(new Range(1, 20, 1, 25)));
  });

  test('keeps member properties and omits contract properties', async () => {
    const content = [
      'variableContainer variableProperty functionContainer functionProperty',
      'classContainer classProperty interfaceContainer interfaceProperty',
      'default flatProperty'
    ].join('\n');
    const document = await workspace.openTextDocument({
      content,
      language: 'typescript'
    });
    const createNamedSymbol = (
      name: string,
      kind: SymbolKind
    ): DocumentSymbol => {
      const nameOffset = content.indexOf(name);

      assert.notEqual(nameOffset, -1);

      const nameRange = new Range(
        document.positionAt(nameOffset),
        document.positionAt(nameOffset + name.length)
      );

      return new DocumentSymbol(name, '', kind, nameRange, nameRange);
    };
    const variableContainer = createNamedSymbol(
      'variableContainer',
      SymbolKind.Variable
    );
    const functionContainer = createNamedSymbol(
      'functionContainer',
      SymbolKind.Function
    );
    const classContainer = createNamedSymbol('classContainer', SymbolKind.Class);
    const interfaceContainer = createNamedSymbol(
      'interfaceContainer',
      SymbolKind.Interface
    );
    const defaultExport = createNamedSymbol('default', SymbolKind.Variable);
    const flatPropertyRange = createNamedSymbol(
      'flatProperty',
      SymbolKind.Property
    ).range;
    const flatProperty = new SymbolInformation(
      'flatProperty',
      SymbolKind.Property,
      '',
      new Location(document.uri, flatPropertyRange)
    );

    variableContainer.children.push(
      createNamedSymbol('variableProperty', SymbolKind.Property)
    );
    functionContainer.children.push(
      createNamedSymbol('functionProperty', SymbolKind.Property)
    );
    classContainer.children.push(
      createNamedSymbol('classProperty', SymbolKind.Property)
    );
    interfaceContainer.children.push(
      createNamedSymbol('interfaceProperty', SymbolKind.Property)
    );

    const result = getSymbolData([
      variableContainer,
      functionContainer,
      classContainer,
      interfaceContainer,
      defaultExport,
      flatProperty
    ], document);

    assert.deepEqual(result.map(symbol => symbol.name), [
      'variableContainer',
      'functionContainer',
      'classContainer',
      'classProperty',
      'interfaceContainer',
      'interfaceProperty'
    ]);
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
