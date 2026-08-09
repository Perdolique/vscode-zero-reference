import { CodeLens, commands, EventEmitter } from 'vscode';
import type {
  CancellationToken,
  CodeLensProvider,
  Disposable,
  DocumentSymbol,
  Location,
  Position,
  SymbolInformation,
  TextDocument,
  Uri
} from 'vscode';
import { getUseCodeLens } from './config.js';
import { getSymbolData } from './symbols.js';

export class ZeroReferenceCodeLensProvider implements CodeLensProvider, Disposable {
  private readonly updateEventEmitter = new EventEmitter<void>();

  readonly onDidChangeCodeLenses = this.updateEventEmitter.event;

  refresh(): void {
    this.updateEventEmitter.fire();
  }

  dispose(): void {
    this.updateEventEmitter.dispose();
  }

  async provideCodeLenses(
    document: TextDocument,
    token: CancellationToken
  ): Promise<CodeLens[]> {
    if (!getUseCodeLens() || token.isCancellationRequested) {
      return [];
    }

    const symbols = await commands.executeCommand<DocumentSymbol[] | SymbolInformation[]>(
      'vscode.executeDocumentSymbolProvider',
      document.uri
    );

    if (symbols === undefined || token.isCancellationRequested) {
      return [];
    }

    const symbolData = getSymbolData(symbols, document.languageId);
    const codeLensResults = symbolData.map(async ({ name, range, referencePosition }) => {
      if (token.isCancellationRequested) {
        return null;
      }

      const hasZeroReferences = await this.hasZeroReferences(
        document.uri,
        referencePosition
      );

      if (!hasZeroReferences || token.isCancellationRequested) {
        return null;
      }

      return new CodeLens(range, {
        title: `"${name}" has zero references`,
        command: ''
      });
    });

    const codeLenses = await Promise.all(codeLensResults);

    if (token.isCancellationRequested) {
      return [];
    }

    return codeLenses.filter((codeLens): codeLens is CodeLens => codeLens !== null);
  }

  private async hasZeroReferences(uri: Uri, startPosition: Position): Promise<boolean> {
    const locations = await commands.executeCommand<Location[]>(
      'vscode.executeReferenceProvider',
      uri,
      startPosition
    );

    if (locations === undefined) {
      return false;
    }

    if (locations.length === 0) {
      return true;
    }

    const [location] = locations;

    return locations.length === 1
      && location !== undefined
      && location.range.start.isEqual(startPosition);
  }
}
