# 4. Ephemeral harness pod per session, one always warm

- Status: Accepted
- Date: 2026-10-18

## Context

Sessions must start clean and fast, and idle sessions must hold no pods (Principles 4 and 5). See [Decision log](../spec.md#decision-log).

## Decision

Each session gets its own ephemeral harness pod. One harness and one sandbox stay warm so starts are fast.

## Consequences

State is clean per session and any pod can be killed (Principle 2). The two warm pods cost about 900 MiB of the cloud budget, and the warm pod shows how fast starts can be.
