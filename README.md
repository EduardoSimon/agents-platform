# Agents Platform

Each agent session is one Temporal workflow over an append-only event log, so any pod can die and the session resumes. The agent loop runs in a disposable harness pod, tools run in an isolated sandbox pod, and credentials live only in the egress proxy. The baseline is a Mac mini M4 with Kata microVMs; fake prod is one VPS under €20 a month with gVisor.

## First commands

```sh
mise trust && mise install && pnpm install
mise run check
```

## Where things are

- [`docs/spec.md`](docs/spec.md): the platform spec.
- [`docs/adr/`](docs/adr): decisions and the ADR template.
- [`CONTRIBUTING.md`](CONTRIBUTING.md): the story workflow and conventions.
- `apps/`, `packages/`, `images/`, `examples/`, `deploy/`, `infra/`: see the README in each.
