import { CodeLens, commands, EventEmitter } from 'vscode';
import type {
  CancellationToken,
  CodeLensProvider,
  Disposable,
  DocumentSymbol,
  Location,
  Range,
  SymbolInformation,
  TextDocument,
  Uri
} from 'vscode';
import { getUseCodeLens } from './config.js';
import { getSymbolData } from './symbols.js';
import type { SymbolData } from './symbols.js';

const referenceConcurrency = 4;

export type CommandExecutor = <Result>(
  command: string,
  ...args: readonly unknown[]
) => Thenable<Result | undefined>;

interface CodeLensCandidate {
  readonly codeLens: CodeLens;
  readonly declarationGroupKey: string;
}

function executeVSCodeCommand<Result>(
  command: string,
  ...args: readonly unknown[]
): Thenable<Result | undefined> {
  return commands.executeCommand<Result>(command, ...args);
}

export class ZeroReferenceCodeLensProvider implements CodeLensProvider, Disposable {
  private readonly referenceLookupLimiter = new ConcurrencyLimiter(referenceConcurrency);
  private readonly updateEventEmitter = new EventEmitter<void>();
  private generation = 0;

  readonly onDidChangeCodeLenses = this.updateEventEmitter.event;

  constructor(
    private readonly executeCommand: CommandExecutor = executeVSCodeCommand,
    private readonly isEnabled: () => boolean = getUseCodeLens
  ) {}

  refresh(): void {
    this.generation += 1;
    this.updateEventEmitter.fire();
  }

  dispose(): void {
    this.generation += 1;
    this.updateEventEmitter.dispose();
  }

  async provideCodeLenses(
    document: TextDocument,
    token: CancellationToken
  ): Promise<CodeLens[]> {
    const documentVersion = document.version;
    const generation = this.generation;

    if (!this.isCalculationCurrent(document, documentVersion, generation, token)) {
      return [];
    }

    let hasLoggedError = false;
    const logErrorOnce = (error: unknown): void => {
      if (hasLoggedError) {
        return;
      }

      hasLoggedError = true;
      console.error(error);
    };

    let symbols: DocumentSymbol[] | SymbolInformation[] | undefined;

    try {
      symbols = await this.executeCommand<DocumentSymbol[] | SymbolInformation[]>(
        'vscode.executeDocumentSymbolProvider',
        document.uri
      );
    } catch (error: unknown) {
      logErrorOnce(error);
      return [];
    }

    if (symbols === undefined
      || !this.isCalculationCurrent(document, documentVersion, generation, token)) {
      return [];
    }

    const symbolData = getSymbolData(symbols, document);
    const declarationIdentitiesByRange = getDeclarationIdentitiesByRange(symbolData);
    const candidates = await this.findCodeLensCandidates(
      document,
      documentVersion,
      symbolData,
      declarationIdentitiesByRange,
      generation,
      token,
      logErrorOnce
    );

    if (!this.isCalculationCurrent(document, documentVersion, generation, token)) {
      return [];
    }

    const seenDeclarationGroups = new Set<string>();
    const codeLenses: CodeLens[] = [];

    for (const candidate of candidates) {
      if (candidate === null
        || seenDeclarationGroups.has(candidate.declarationGroupKey)) {
        continue;
      }

      seenDeclarationGroups.add(candidate.declarationGroupKey);
      codeLenses.push(candidate.codeLens);
    }

    return codeLenses;
  }

  private async findCodeLensCandidates(
    document: TextDocument,
    documentVersion: number,
    symbols: readonly SymbolData[],
    declarationIdentitiesByRange: ReadonlyMap<string, ReadonlySet<string>>,
    generation: number,
    token: CancellationToken,
    logErrorOnce: (error: unknown) => void
  ): Promise<readonly (CodeLensCandidate | null)[]> {
    const candidates: (CodeLensCandidate | null)[] = Array.from(
      { length: symbols.length },
      () => null
    );
    let nextSymbolIndex = 0;

    const runWorker = async (): Promise<void> => {
      while (this.isCalculationCurrent(
        document,
        documentVersion,
        generation,
        token
      )) {
        const symbolIndex = nextSymbolIndex;

        if (symbolIndex >= symbols.length) {
          return;
        }

        nextSymbolIndex += 1;
        const symbol = symbols[symbolIndex];

        if (symbol === undefined
          || !this.isCalculationCurrent(
            document,
            documentVersion,
            generation,
            token
          )) {
          return;
        }

        const releaseReferenceLookup = await this.referenceLookupLimiter.acquire();

        if (!this.isCalculationCurrent(
          document,
          documentVersion,
          generation,
          token
        )) {
          releaseReferenceLookup();
          return;
        }

        let locations: Location[] | undefined;

        try {
          locations = await this.executeCommand<Location[]>(
            'vscode.executeReferenceProvider',
            document.uri,
            symbol.referencePosition
          );
        } catch (error: unknown) {
          logErrorOnce(error);
          continue;
        } finally {
          releaseReferenceLookup();
        }

        if (!this.isCalculationCurrent(
          document,
          documentVersion,
          generation,
          token
        )) {
          return;
        }

        const declarationGroupKey = getDeclarationGroupKey(
          document.uri,
          locations,
          declarationIdentitiesByRange,
          getDeclarationIdentityKey(symbol)
        );

        if (declarationGroupKey === undefined) {
          continue;
        }

        candidates[symbolIndex] = {
          codeLens: new CodeLens(symbol.range, {
            title: `"${symbol.name}" has zero references`,
            command: ''
          }),
          declarationGroupKey
        };
      }
    };

    const workerCount = Math.min(referenceConcurrency, symbols.length);
    const workers = Array.from({ length: workerCount }, runWorker);

    await Promise.all(workers);

    return candidates;
  }

  private isCalculationCurrent(
    document: TextDocument,
    documentVersion: number,
    generation: number,
    token: CancellationToken
  ): boolean {
    return generation === this.generation
      && document.version === documentVersion
      && this.isEnabled()
      && !token.isCancellationRequested;
  }
}

function getDeclarationIdentitiesByRange(
  symbols: readonly SymbolData[]
): ReadonlyMap<string, ReadonlySet<string>> {
  const identitiesByRange = new Map<string, Set<string>>();

  for (const symbol of symbols) {
    const rangeKey = getRangeKey(symbol.declarationRange);
    const identities = identitiesByRange.get(rangeKey) ?? new Set<string>();

    identities.add(getDeclarationIdentityKey(symbol));
    identitiesByRange.set(rangeKey, identities);
  }

  return identitiesByRange;
}

function getDeclarationIdentityKey(symbol: SymbolData): string {
  return `${symbol.kind}:${symbol.normalizedName}`;
}

function getDeclarationGroupKey(
  documentUri: Uri,
  locations: readonly Location[] | undefined,
  declarationIdentitiesByRange: ReadonlyMap<string, ReadonlySet<string>>,
  declarationIdentityKey: string
): string | undefined {
  if (locations === undefined || locations.length === 0) {
    return undefined;
  }

  const locationKeys = new Set<string>();

  for (const location of locations) {
    const locationKey = getRangeKey(location.range);
    const declarationIdentities = declarationIdentitiesByRange.get(locationKey);

    if (location.uri.toString() !== documentUri.toString()
      || !declarationIdentities?.has(declarationIdentityKey)) {
      return undefined;
    }

    locationKeys.add(locationKey);
  }

  return [...locationKeys].sort().join('|');
}

function getRangeKey(range: Range): string {
  return `${range.start.line}:${range.start.character}-${range.end.line}:${range.end.character}`;
}

class ConcurrencyLimiter {
  private activeCount = 0;
  private readonly pendingAcquisitions: Array<(release: () => void) => void> = [];

  constructor(private readonly maximumCount: number) {}

  acquire(): Promise<() => void> {
    if (this.activeCount < this.maximumCount) {
      this.activeCount += 1;
      return Promise.resolve(this.createRelease());
    }

    return new Promise(resolve => {
      this.pendingAcquisitions.push(resolve);
    });
  }

  private createRelease(): () => void {
    let hasReleased = false;

    return () => {
      if (hasReleased) {
        return;
      }

      hasReleased = true;
      const nextAcquisition = this.pendingAcquisitions.shift();

      if (nextAcquisition === undefined) {
        this.activeCount -= 1;
        return;
      }

      nextAcquisition(this.createRelease());
    };
  }
}
