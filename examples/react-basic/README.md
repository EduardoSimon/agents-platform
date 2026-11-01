# react-basic

A plain Vite + React + TypeScript app with Vitest, used as a starting workspace inside the sandbox.

```sh
pnpm install
pnpm test   # Vitest, src/ only
pnpm dev    # http://localhost:5173
```

`demo/` holds acceptance tests for demos. They are outside Vitest's include and fail against this app on purpose: a demo copies one into `src/` (for example `cp demo/dark-mode.test.tsx src/`) and asks an agent to make it pass.
