# 1. Temporal with agent-sandbox for session orchestration

- Status: Accepted
- Date: 2026-10-18

## Context

Each agent session can wait days for a human, retry tool calls and pause or resume on demand. Principle 6 says upstream before custom and that we write no Kubernetes operator. See [Decision log](../spec.md#decision-log).

## Decision

Each session is one Temporal workflow, and agent-sandbox manages the pods. CRDs stay for declarative config only.

## Consequences

| | Temporal workflows | Custom Kubernetes operator |
| --- | --- | --- |
| Pause and resume one session | A signal | Patch the spec and reconcile |
| Wait days for a human | A workflow waits on a signal with no pods | Requeue loops and timers you build |
| Retries and heartbeats | Built in per activity | You build them |
| Testing | Time-skipping test environment | envtest, slower |
| Extra footprint | A server of about 350 MB plus a Postgres schema | None |
| Kubernetes view | Through the API and console | `kubectl get sessions` |
| Lock-in | The Temporal SDK in the worker | None |

Temporal wins on the hard parts: long waits, retries and per-session timers. The cost is about 350 MB of memory and lock-in to the Temporal SDK in the worker. Workflows stay plain Temporal code with no Effect inside (see the Coding standards, rule 7).
