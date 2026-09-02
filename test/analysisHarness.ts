import { strict as assert } from 'node:assert'
import { CancellationTokenSource, commands, Location, Position } from 'vscode'
import type { DocumentSymbol, SymbolInformation, TextDocument } from 'vscode'
import { ZeroReferenceAnalyzer } from '../src/analysis.js'
import type { CommandExecutor } from '../src/analysis.js'
import { getSymbolData } from '../src/symbols.js'
import type { SymbolData } from '../src/symbols.js'

type ReferenceLookup = (
  symbol: SymbolData,
  symbols: readonly SymbolData[]
) => readonly Location[] | Promise<readonly Location[]>

interface AnalysisCounts {
  documentSymbolCalls: number;
  readonly referenceNames: string[];
}

/** Uses real language-provider ranges with controllable references and observable lookup counts. */
export function createAnalysisHarness(document: TextDocument, getReferences?: ReferenceLookup) {
  const counts: AnalysisCounts = {
    documentSymbolCalls: 0,
    referenceNames: []
  }

  const warnings: string[] = []
  let symbols: readonly SymbolData[] = []

  const executeCommand: CommandExecutor = async <Result>(
    command: string,
    ...args: readonly unknown[]
  ): Promise<Result | undefined> => {
    if (command === 'vscode.executeDocumentSymbolProvider') {
      counts.documentSymbolCalls += 1

      const result = await commands.executeCommand<(DocumentSymbol | SymbolInformation)[]>(command, document.uri)

      symbols = getSymbolData(result ?? [], document)

      return result as Result
    }

    assert.equal(command, 'vscode.executeReferenceProvider')

    const position = args[1]

    assert.ok(position instanceof Position)

    const symbol = symbols.find(candidate => candidate.referencePosition.isEqual(position))

    assert.ok(symbol !== undefined, `missing symbol at ${position.line}:${position.character}`)
    counts.referenceNames.push(symbol.normalizedName)

    const references = getReferences === undefined
      ? [new Location(document.uri, symbol.declarationRange)]
      : await getReferences(symbol, symbols)

    return references as Result
  }

  const reportWarning = (message: string): void => {
    warnings.push(message)
  }

  const analyzer = new ZeroReferenceAnalyzer(executeCommand, reportWarning)
  const cancellation = new CancellationTokenSource()

  return {
    analyzer,
    cancellation,
    counts,
    warnings,

    dispose(): void {
      analyzer.dispose()
      cancellation.dispose()
    }
  }
}
