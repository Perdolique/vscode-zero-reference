import { ConfigurationTarget, workspace } from 'vscode';

const useCodeLensKey = 'useCodeLens';

export function getUseCodeLens(): boolean {
  return workspace
    .getConfiguration('zeroReference')
    .get<boolean>(useCodeLensKey, true);
}

export async function updateUseCodeLens(value: boolean): Promise<void> {
  const configuration = workspace.getConfiguration('zeroReference');

  await configuration.update(useCodeLensKey, value, ConfigurationTarget.Global);
}
