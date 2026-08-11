import { ConfigurationTarget, workspace } from 'vscode';
import type { Disposable } from 'vscode';

const useCodeLensKey = 'useCodeLens';
const useCodeLensConfigurationKey = `zeroReference.${useCodeLensKey}`;

export function getUseCodeLens(): boolean {
  return workspace
    .getConfiguration('zeroReference')
    .get<boolean>(useCodeLensKey, true);
}

export async function updateUseCodeLens(value: boolean): Promise<void> {
  const configuration = workspace.getConfiguration('zeroReference');
  const inspection = configuration.inspect<boolean>(useCodeLensKey);
  const target = inspection?.workspaceValue === undefined
    ? ConfigurationTarget.Global
    : ConfigurationTarget.Workspace;

  await configuration.update(useCodeLensKey, value, target);
}

export function registerUseCodeLensListener(onChange: () => void): Disposable {
  return workspace.onDidChangeConfiguration(event => {
    if (event.affectsConfiguration(useCodeLensConfigurationKey)) {
      onChange();
    }
  });
}
