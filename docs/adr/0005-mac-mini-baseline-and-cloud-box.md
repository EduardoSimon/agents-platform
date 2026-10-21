# 5. Mac mini M4 as the baseline, plus a cloud VPS at €10 to €20 a month

- Status: Accepted
- Date: 2026-10-18

## Context

We want real microVMs at home and a public endpoint for little money, and every later story checks its resource use against fixed budgets. See [Environments and deployment](../spec.md#environments-and-deployment).

## Decision

The baseline is a Mac mini M4 running a Lima VM with Kata. Fake prod is a Hetzner CAX21 with gVisor. The laptop runs the same Lima template without nested virtualization.

## Consequences

Budget numbers that stories must respect:

- Mac mini: 16 GB, with a Lima VM of 8 vCPUs and 12 GB, leaving 4 GB for macOS.
- Hetzner CAX21: 4 Arm vCPUs and 8 GB; the lean profile totals about 5,700 MiB.
- Cloud cost: €10 to €20 a month (CAX21 about €10.49 plus about €0.50 for IPv4; CAX31 with 16 GB is about €21.50 if 8 GB is too tight).

Every machine is arm64, so images build once with no cross-compiling.
