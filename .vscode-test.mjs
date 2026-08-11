import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
  files: 'build-test/test/**/*.test.js',
  version: '1.125.0',
  workspaceFolder: './test/fixtures/workspace',
  launchArgs: ['--disable-extensions'],
  mocha: {
    failZero: true,
    timeout: 60_000
  }
});
