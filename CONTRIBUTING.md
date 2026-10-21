# Contributing

## Story workflow

- One story per branch, named `story/<n>-<slug>`, cut from `main`. One story at a time.
- Tests first: write the failing test, commit it, then write the minimum code to pass.
- Refactors go in their own commits, with no new behavior and no new test expectations.
- Run `mise run check` before pushing. It must pass with no warnings.
- Open a pull request that says `Closes #<n>`. Nothing lands on `main` except through a squashed PR.
- A change that breaks one of the spec's [Principles](docs/spec.md#principles) needs an ADR in `docs/adr/` (copy `0000-template.md`).

## Commit format

```
<type>: <description>

<body explaining WHY the change was made>
```

- Types: `feat`, `fix`, `chore`, `ci`, `docs`, `test`.
- The title is at most 80 characters. The body explains why, not what.

## Setup

```sh
mise trust && mise install && pnpm install
mise run check
```

`mise run check` runs these steps one after another and fails if any one fails: `format:check`, `lint`, `typecheck`, `test`, `build`. Run `mise run format` to fix formatting.

## Conventions

- **Coding standards:** TypeScript follows the seven rules in [Coding standards in Effect](docs/spec.md#coding-standards-in-effect). These rules are agreed.
- **Tooling:** Biome is the only formatter and linter for TypeScript. It replaces the `@effect/eslint-plugin` named in the spec; the Effect language service runs in the editor. `gofmt` and `go vet` cover Go.
- **Effect version:** `effect` and every `@effect/*` package stay on one matched release set (3.x, the version the standards are written for). Moving to a new Effect major needs an ADR.
- **Types and build:** `typecheck` is the root `tsc -b`. Each package owns its `build` script, so bundling for `images/` can be added without touching `check`.
- **New packages:** copy `packages/sample`. Its `exports` use an `@agents-platform/source` condition (`src/index.ts`), with `dist` as the default, so tests and types work on a clean clone without a build.
- **Go:** one module, `apps/egress`, run with `go -C apps/egress …`. There is no `go.work`. `GOTOOLCHAIN=local` keeps the mise pin as the only Go version.
- **Examples:** `examples/*` are standalone projects with their own lockfiles and are not part of `check`.
