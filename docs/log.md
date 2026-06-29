# Log Module

`src/log/index.ts` provides a lightweight structured logger for hy-workflow.

## API

- `log(level, message)` — core log function
- `info(message)`, `warn(message)`, `error(message)`, `debug(message)` — shorthand
- `createLogger(context)` — contextual logger

Levels supported: `debug`, `info`, `warn`, `error`.

## Contract

- All log output goes to `console` (stderr for errors).
- Logging must not throw.
- The module has no external dependencies.
