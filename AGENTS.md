# Repository instructions

## Package management

- Use `vp` for package manager commands run locally by users and agents.

## Verification

- After changing files, run `vp run format` before any other applicable verification command.
- Run `vp run test` after TypeScript, configuration, or test changes.
- Run `vp run package` after extension manifest or packaged runtime changes.
