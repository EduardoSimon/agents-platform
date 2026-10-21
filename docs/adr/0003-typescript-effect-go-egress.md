# 3. TypeScript with Effect, and Go only for the egress proxy

- Status: Accepted
- Date: 2026-10-18

## Context

The API, worker, harness and tools need one language, while the egress proxy is a small, fast TLS proxy that holds credentials (Principle 3). See [Decision log](../spec.md#decision-log) and [Coding standards in Effect](../spec.md#coding-standards-in-effect).

## Decision

All services are TypeScript with Effect. Go is used only for the egress proxy in `apps/egress`, so there is one Go module and no Go workspace.

## Consequences

A reviewer reads the API, the worker and the harness the same way. Two toolchains stay pinned in `mise.toml`, and `mise run check` covers both. Moving to a new Effect major version needs an ADR.
