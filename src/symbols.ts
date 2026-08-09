import { SymbolKind } from 'vscode';
import type {
  DocumentFilter,
  DocumentSymbol,
  Position,
  Range,
  SymbolInformation
} from 'vscode';

interface SymbolData {
  readonly name: string;
  readonly range: Range;
  readonly referencePosition: Position;
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
  languageId: string
): SymbolData[] {
  const symbolData: SymbolData[] = [];

  for (const symbol of symbols) {
    if (isDocumentSymbol(symbol)) {
      symbolData.push(...flattenDocumentSymbol(symbol, languageId));
      continue;
    }

    if (isKindSupported(symbol.kind, languageId)) {
      symbolData.push({
        name: symbol.name,
        range: symbol.location.range,
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

function isDocumentSymbol(
  symbol: DocumentSymbol | SymbolInformation
): symbol is DocumentSymbol {
  return 'selectionRange' in symbol;
}

// Flatten nested document symbols while preserving their declaration positions.
function flattenDocumentSymbol(symbol: DocumentSymbol, languageId: string): SymbolData[] {
  const symbolData: SymbolData[] = [];

  if (isKindSupported(symbol.kind, languageId)) {
    symbolData.push({
      name: symbol.name,
      range: symbol.range,
      referencePosition: symbol.selectionRange.start
    });
  }

  for (const child of symbol.children) {
    symbolData.push(...flattenDocumentSymbol(child, languageId));
  }

  return symbolData;
}
