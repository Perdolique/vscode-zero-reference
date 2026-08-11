import { commands, languages } from 'vscode';
import type { ExtensionContext } from 'vscode';
import { ZeroReferenceCodeLensProvider } from './codeLensProvider.js';
import {
  getUseCodeLens,
  registerUseCodeLensListener,
  updateUseCodeLens
} from './config.js';
import { getDocumentFilter } from './symbols.js';

export function activate(context: ExtensionContext): void {
  const codeLensProvider = new ZeroReferenceCodeLensProvider();
  const documentFilter = getDocumentFilter();

  context.subscriptions.push(
    codeLensProvider,
    commands.registerCommand('zeroReference.toggleCodeLens', async () => {
      const useCodeLens = getUseCodeLens();

      await updateUseCodeLens(!useCodeLens);
    }),
    registerUseCodeLensListener(() => codeLensProvider.refresh()),
    languages.registerCodeLensProvider(documentFilter, codeLensProvider)
  );
}
