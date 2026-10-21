# 2. CloudNativePG for Postgres

- Status: Accepted
- Date: 2026-10-18

## Context

Principle 1 makes the event log in Postgres the truth, so Postgres needs declarative management and backups. See [Decision log](../spec.md#decision-log).

## Decision

Postgres runs under CloudNativePG, with backups to S3-compatible storage (Garage).

## Consequences

Clusters are declared as manifests and fit the GitOps flow. We depend on the CloudNativePG operator and must size its memory (about 450 MiB with Postgres in the lean profile). If one Postgres outgrows the load, the scale-out path is in Principle 1.
