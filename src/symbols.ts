import { Range, SymbolKind } from 'vscode';
import type {
  DocumentFilter,
  DocumentSymbol,
  Position,
  SymbolInformation,
  TextDocument
} from 'vscode';

export interface SymbolData {
  readonly kind: SymbolKind;
  readonly name: string;
  readonly normalizedName: string;
  readonly range: Range;
  readonly declarationRange: Range;
  readonly referencePosition: Position;
}

interface PendingDocumentSymbol {
  readonly parentKind: SymbolKind | undefined;
  readonly symbol: DocumentSymbol;
}

const supportedKinds: ReadonlyMap<string, readonly SymbolKind[]> = new Map([
  ['typescript', [
    SymbolKind.Class,
    SymbolKind.Function,
    SymbolKind.Method,
    SymbolKind.Property,
    SymbolKind.Variable,
    SymbolKind.Enum,
    SymbolKind.Interface,
    SymbolKind.Module
  ]],
  ['typescriptreact', [
    SymbolKind.Class,
    SymbolKind.Function,
    SymbolKind.Method,
    SymbolKind.Property,
    SymbolKind.Variable,
    SymbolKind.Enum,
    SymbolKind.Interface,
    SymbolKind.Module
  ]],
  ['javascript', [
    SymbolKind.Class,
    SymbolKind.Function,
    SymbolKind.Method,
    SymbolKind.Property,
    SymbolKind.Variable
  ]],
  ['javascriptreact', [
    SymbolKind.Class,
    SymbolKind.Function,
    SymbolKind.Method,
    SymbolKind.Property,
    SymbolKind.Variable
  ]]
]);

export function getDocumentFilter(): DocumentFilter[] {
  return [...supportedKinds.keys()].map(language => ({ language }));
}

export function getSymbolData(
  symbols: readonly (DocumentSymbol | SymbolInformation)[],
  document: TextDocument
): SymbolData[] {
  const symbolData: SymbolData[] = [];

  for (const symbol of symbols) {
    if (isDocumentSymbol(symbol)) {
      appendDocumentSymbols(symbolData, symbol, document);
      continue;
    }

    const normalizedName = normalizeSymbolName(symbol.name);

    if (isSymbolEligible(
      symbol.kind,
      normalizedName,
      undefined,
      document.languageId
    )) {
      symbolData.push({
        kind: symbol.kind,
        name: symbol.name,
        normalizedName,
        range: symbol.location.range,
        declarationRange: symbol.location.range,
        referencePosition: symbol.location.range.start
      });
    }
  }

  return symbolData;
}

function isKindSupported(kind: SymbolKind, languageId: string): boolean {
  const kinds = supportedKinds.get(languageId);

  return kinds?.includes(kind) ?? false;
}

function isSymbolEligible(
  kind: SymbolKind,
  normalizedName: string,
  parentKind: SymbolKind | undefined,
  languageId: string
): boolean {
  if (!isKindSupported(kind, languageId)) {
    return false;
  }

  if (parentKind === undefined && normalizedName === 'default') {
    return false;
  }

  return kind !== SymbolKind.Property
    || parentKind === SymbolKind.Class
    || parentKind === SymbolKind.Interface;
}

function isDocumentSymbol(
  symbol: DocumentSymbol | SymbolInformation
): symbol is DocumentSymbol {
  return 'selectionRange' in symbol;
}

function appendDocumentSymbols(
  destination: SymbolData[],
  root: DocumentSymbol,
  document: TextDocument
): void {
  const pending: PendingDocumentSymbol[] = [{
    parentKind: undefined,
    symbol: root
  }];

  while (pending.length > 0) {
    const pendingSymbol = pending.pop();

    if (pendingSymbol === undefined) {
      continue;
    }

    const { parentKind, symbol } = pendingSymbol;
    const normalizedName = normalizeSymbolName(symbol.name);

    if (isSymbolEligible(
      symbol.kind,
      normalizedName,
      parentKind,
      document.languageId
    )) {
      const declarationRange = getDeclarationRange(symbol, document);

      if (declarationRange !== undefined) {
        destination.push({
          kind: symbol.kind,
          name: symbol.name,
          normalizedName,
          range: symbol.range,
          declarationRange,
          referencePosition: declarationRange.start
        });
      }
    }

    for (let index = symbol.children.length - 1; index >= 0; index -= 1) {
      const child = symbol.children[index];

      if (child !== undefined) {
        pending.push({ parentKind: symbol.kind, symbol: child });
      }
    }
  }
}

function getDeclarationRange(
  symbol: DocumentSymbol,
  document: TextDocument
): Range | undefined {
  if (!symbol.selectionRange.isEqual(symbol.range)) {
    return symbol.selectionRange;
  }

  const name = normalizeSymbolName(symbol.name);

  if (name.length === 0) {
    return undefined;
  }

  const declarationText = document.getText(symbol.range);
  const occurrenceOffsets = findStandaloneOccurrences(declarationText, name);

  if (occurrenceOffsets.length !== 1) {
    return undefined;
  }

  const occurrenceOffset = occurrenceOffsets[0];

  if (occurrenceOffset === undefined) {
    return undefined;
  }

  const declarationOffset = document.offsetAt(symbol.range.start);
  const nameOffset = declarationOffset + occurrenceOffset;

  return new Range(
    document.positionAt(nameOffset),
    document.positionAt(nameOffset + name.length)
  );
}

function normalizeSymbolName(name: string): string {
  return name.replace(/^\((?:get|set)\)\s+/, '');
}

function findStandaloneOccurrences(text: string, name: string): number[] {
  const offsets: number[] = [];
  let searchOffset = 0;

  while (searchOffset <= text.length - name.length) {
    const occurrenceOffset = text.indexOf(name, searchOffset);

    if (occurrenceOffset === -1) {
      break;
    }

    const precedingCharacter = text[occurrenceOffset - 1];
    const followingCharacter = text[occurrenceOffset + name.length];

    if (!isIdentifierCharacter(precedingCharacter)
      && !isIdentifierCharacter(followingCharacter)) {
      offsets.push(occurrenceOffset);
    }

    searchOffset = occurrenceOffset + name.length;
  }

  return offsets;
}

function isIdentifierCharacter(character: string | undefined): boolean {
  return character !== undefined && /[$_\p{ID_Continue}]/u.test(character);
}
