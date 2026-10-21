> Source: https://claude.ai/artifact/Hk2WUaYwrUw12weM1ghME7 · exported 2026-10-21 · revision 91.
> This copy is what ADRs and issues link to. Design changes go through an ADR first, then a re-export of the spec.

# Agents Platform — Spec v0.1

Oct 18, 2026 · @Gabby

Each agent session is one Temporal workflow over an append-only event log, so any pod can die and the session resumes. The agent loop runs in a disposable harness pod, tools run in an isolated sandbox pod, and credentials live only in the egress proxy. The baseline is a Mac mini M4 with Kata microVMs; fake prod is one VPS under €20 a month with gVisor.

## Goals and non-goals

v1 proves that a self-hosted platform can run long agent sessions that survive crashes, pause for days and never expose a credential.

**Goals**

- Define agents through the API from a backoffice panel, and run many sessions of each.
- Pick the harness per session with a flag: deepagents by default, or Pi Durable.
- Run every command in a separate sandbox pod. The harness has no local shell or file tools and reaches the pod over the network, through sandbox MCP or a direct tool call to sandboxd's HTTP API.
- Keep credentials in OpenBao and add them at the egress proxy, so the harness and the sandbox never hold them.
- Pause, resume and cancel each session on its own, through overnight runs and multi-day waits for a human.
- Let the agent ask you a question, request approval or warn you, in the console inbox, which you open from your phone over Tailscale.
- Make agents improve across sessions with memory stores and a reflection step after each session.
- SSH into a session's sandbox and open a live preview of the app inside it.
- Store records in Postgres and transcripts in S3, and trace every turn end to end.
- Track token use (input, output, cache) and its cost per agent and per session, and show it in the backoffice.
- Run the same manifests on the Mac mini M4 and on a VPS that costs at most €20 a month.

**Non-goals for v1**

- Hosted third-party services. The only outside calls are the model APIs and the connectors an agent is allowed to use. In v1 the connectors are the GitHub MCP server and the Linear MCP server; more come later.
- Multiple tenants, quotas or billing. There is one owner and a few trusted users. Token use and cost are still tracked per agent.
- High availability. Each service runs one replica; durability comes from Postgres, S3 and Temporal, not from replicas.
- CI. `mise run check` runs format, lint, types, tests and build on your machine. mise is the single entry point for every tool version and task, locally and in the cloud.
- Self-hosted models or GPUs. Every model is a remote API.
- A Firecracker snapshot fleet like Vercel's Hive. No spike toward one either.
- Agents as YAML in Git, or a CLI. People create and change agents only in the backoffice, which calls the API.

## Principles

Seven rules settle most design questions. A change that breaks one needs an ADR in `docs/adr`.

1. **The event log is the truth.** Each session is an append-only log in Postgres. Pods, caches and harness checkpoints are derived from it and can be rebuilt. If one Postgres outgrows the load, the path is a scale-out Postgres such as PlanetScale; past that, a control-plane cluster that agrees on writes through consensus (Raft or Paxos). Neither is in v1.
2. **Every process is replaceable.** Harness, sandbox, worker, proxy and API pods keep nothing that is not in Postgres, S3 or the workspace volume. Killing one is a test case, not an incident.
3. **Credentials stop at the egress.** Pods get placeholder tokens, and the proxy swaps them for real ones. Memories and transcripts never hold secrets.
4. **Sessions are independent.** Each one has its own workflow, pods, network policy and token. Pausing or crashing one never touches another.
5. **Idle sessions hold no pods.** A waiting session keeps only its workspace volume. One warm harness and one warm sandbox stay ready, so starts are fast.
6. **Upstream before custom.** We use Temporal, agent-sandbox, CloudNativePG, CRDs, NetworkPolicy and RuntimeClass. We write no Kubernetes operator.
7. **Small, reviewable steps.** One story per branch, tests first, and refactors in their own commits.

## Architecture

&#91;embedded content: platform architecture · 11 parts, one session shown\]

A turn flows from you through the API and Temporal to the harness, which calls tools in the sandbox. Every call that leaves the session passes the egress proxy, the only place a credential is added.

## Components

Each component has one job. Only Postgres, object storage, OpenBao and the workspace volumes hold durable state.

| Component | Technology | Job | Durable state |
| --- | --- | --- | --- |
| Control plane API | TypeScript, Effect `HttpApi` | Agents, sessions, events, HITL, memory and connectors; auth; SSE streams | None (Postgres) |
| Session worker | Temporal TypeScript worker, Effect activities | Runs `SessionWorkflow` and `ReflectWorkflow`, claims pods, drives the harness | None (Temporal) |
| Temporal | Single-process server with the UI | Durable timers, signals, retries and workflow history | Postgres |
| Harness runtime | TypeScript, Effect, one adapter per SDK | Runs model turns, writes canonical events, checkpoints | None (S3 checkpoints) |
| Sandbox | Debian slim, Node 24, `sandboxd`, sshd | Runs commands, files, processes and dev servers over MCP or HTTP | Workspace PVC |
| agent-sandbox | kubernetes-sigs controller v1.0.2 | Sandbox pods, warm pools, claims, stable hostnames, PVCs | Kubernetes objects |
| Egress proxy | Go | Allowlist, TLS interception for connector hosts, credential injection, audit | None (OpenBao) |
| OpenBao | KV v2 with Kubernetes auth | Connector credentials | Raft storage |
| Postgres | CloudNativePG with pgvector | Agents, sessions, event log, HITL, memory, audit | PVC, backups to S3 |
| Object storage | Garage (S3 API) | Transcripts, workspace archives, checkpoints, backups | Disk |
| Feature flags | flagd with OpenFeature | `harness.kind` and gradual rollouts | Git |
| SSH gateway | sshpiper and `ssh-waker` (TypeScript) | SSH into a session's sandbox, wake on connect | None |
| Preview gateway | TypeScript, Effect | Preview URLs, auth, wake on request, WebSockets | None |
| Console | React, Vite, shadcn/ui | Backoffice: create and version agents, token use and cost per agent; sessions, transcripts, inbox, memory | None |
| Telemetry | grafana/otel-lgtm | Traces, metrics, logs, dashboards, alerts | PVC |
| GitOps | Argo CD | Syncs each environment from the repo | Git |

## Coding standards in Effect

Every TypeScript service follows the same seven rules, so a reviewer reads the API, the worker and the harness the same way. Each rule is shown with a short snippet in the style the code will use; they are proposals to agree on before story #1.

**1. Schema is the single source of truth.** Types, validation, OpenAPI and the client all come from one `Schema`. No hand-written interfaces for data that crosses a boundary.

```ts
import { Schema } from "effect"

export class AgentSpec extends Schema.Class<AgentSpec>("AgentSpec")({
  name: Schema.String.pipe(Schema.pattern(/^[a-z0-9-]+$/)),
  model: Schema.String,
  harness: Schema.Literal("deepagents", "pi-durable"),
  connectors: Schema.Array(Schema.Literal("github", "linear")),
  budget: Schema.Struct({ maxCostUsd: Schema.Number, maxWallClock: Schema.Duration })
}) {}

export class Agent extends Schema.Class<Agent>("Agent")({
  id: Schema.UUID,
  version: Schema.Int,
  spec: AgentSpec,
  createdAt: Schema.DateTimeUtc
}) {}
```

**2. Errors are typed values, never thrown.** Expected failures are `Schema.TaggedError`s in the error channel and map to an HTTP status. `throw`, `try/catch` and untyped `Promise` stay out of domain code; defects are for bugs only.

```ts
import { HttpApiSchema } from "@effect/platform"

export class AgentNotFound extends Schema.TaggedError<AgentNotFound>()(
  "AgentNotFound",
  { id: Schema.UUID },
  HttpApiSchema.annotations({ status: 404 })
) {}
```

**3. The API is declared, then implemented.** `HttpApi` groups describe endpoints; handlers live in a separate layer. The same definition generates the OpenAPI document and the typed client the backoffice uses.

```typescript
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "@effect/platform"

export class AgentsApi extends HttpApiGroup.make("agents")
  .add(HttpApiEndpoint.post("create", "/agents").setPayload(AgentSpec).addSuccess(Agent))
  .add(
    HttpApiEndpoint.get("get", "/agents/:id")
      .setPath(Schema.Struct({ id: Schema.UUID }))
      .addSuccess(Agent)
      .addError(AgentNotFound)
  ) {}

export class PlatformApi extends HttpApi.make("platform").add(AgentsApi) {}
```

**4. Dependencies are services, wired by layers.** Each dependency is a `Context.Tag` with a live layer and a test layer. Handlers ask for services with `yield*` and never import a client directly.

```ts
import { Context, Effect, Layer } from "effect"
import { HttpApiBuilder } from "@effect/platform"
import { SqlClient } from "@effect/sql"

export class AgentRepo extends Context.Tag("AgentRepo")<AgentRepo, {
  readonly create: (spec: AgentSpec) => Effect.Effect<Agent>
  readonly findById: (id: string) => Effect.Effect<Agent, AgentNotFound>
}>() {}

export const AgentRepoLive = Layer.effect(AgentRepo, Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  // queries with sql`...`, decoded through Schema
  return AgentRepo.of({ create: ..., findById: ... })
}))

export const AgentsLive = HttpApiBuilder.group(PlatformApi, "agents", (handlers) =>
  Effect.gen(function* () {
    const repo = yield* AgentRepo
    return handlers
      .handle("create", ({ payload }) => repo.create(payload))
      .handle("get", ({ path }) => repo.findById(path.id))
  })
)
```

**5. Retries, timeouts and resources are declared.** Every call that leaves the process states its timeout and retry policy with `Schedule`; anything opened is closed with `Effect.acquireRelease` or a scoped layer.

```ts
import { Effect, Schedule } from "effect"

const exec = (req: ExecRequest) =>
  sandbox.exec(req).pipe(
    Effect.timeout("30 minutes"),
    Effect.retry({
      schedule: Schedule.exponential("200 millis").pipe(Schedule.jittered),
      times: 5,
      while: (e) => e._tag === "SandboxUnavailable"
    }),
    Effect.withSpan("sandbox.exec", { attributes: { "sandbox.call_id": req.callId } })
  )
```

**6. Config and secrets go through `Config`.** No `process.env` in code; secrets are `Config.redacted`, so they never reach a log line.

```ts
import { Config } from "effect"
import { PgClient } from "@effect/sql-pg"

export const SqlLive = PgClient.layerConfig({ url: Config.redacted("DATABASE_URL") })
```

**7. Temporal stays at the edge.** Workflows are plain Temporal code with no Effect inside, because they must be deterministic. Activities are thin wrappers that run an Effect program on one `ManagedRuntime` built from the worker's layers.

```ts
import { Effect, Layer, ManagedRuntime } from "effect"

const runtime = ManagedRuntime.make(Layer.mergeAll(SqlLive, SandboxLive, TracingLive))

export const activities = {
  runTurn: (input: TurnInput) =>
    runtime.runPromise(runTurn(input).pipe(Effect.withSpan("activity.runTurn")))
}
```

Tests use `@effect/vitest` with `it.effect` and the test layers, so no test touches the network. Lint adds `@effect/eslint-plugin` and the Effect language service runs in the editor.

## Testing strategy

Most confidence comes from fast tests that need no cluster and no model; slower layers run only what they alone can prove. Tests come first in every story, and `mise run check` runs the fast layers on every change.

| Layer | What it proves | How | When |
| --- | --- | --- | --- |
| Unit | Domain logic, schemas, API handlers, retry and timeout policies | `@effect/vitest` with `it.effect`, test layers and `TestClock`; SQL on PGlite | Every `mise run check` |
| Workflow | Signals, timers, pause and resume, continue-as-new, signal drain | Temporal time-skipping test environment with a fake harness | Every `mise run check` |
| Contract | The backoffice and the API agree | The typed client generated from the `HttpApi` schema, run against the API in memory | Every `mise run check` |
| Harness conformance | Each adapter behaves the same: resume after a kill, checkpoints, yields, budgets, HITL, sandbox-only tools, event shapes, prefix stability | One shared suite, a recorded or fake model for most cases | Before an adapter ships |
| Integration | Postgres, S3, OpenBao, the egress proxy and sandbox pods work together | Against the local k3s cluster on the Mac mini | Before merging a story that touches them |
| Backoffice UI | Agent form, inbox and session views | Vitest and Testing Library for components; Playwright for the main flows against the local cluster | Components every check; Playwright before a merge |
| End to end | Each milestone's demo gate | The dark-mode task on the example app, with a real model | At each milestone |
| Resilience | No state lives in a process | Kill harness, sandbox, worker and API pods mid-turn; restore Postgres from backup | Each milestone, and the drills in story #23 |
| Evals | Agents improve and stay within budget | Cases saved from real session traces in the backoffice, replayed against an agent version; tracks success, turns, tokens and cost | From the backoffice, on demand or when a new agent version is saved |

**Real models only where needed.** Unit, workflow and contract tests never call a model. Conformance uses recorded responses except for the prefix-stability case, so token spend stays with end-to-end runs and evals.

**Determinism.** Time comes from `TestClock` or Temporal's time-skipping, IDs from a seeded generator in test layers, and no unit test touches the network.

## Session lifecycle

&#91;embedded content: session lifecycle · 4 live states, 1 workflow per session\]

Each state releases more: Idle keeps both pods for 10 minutes, Suspended keeps only the workspace volume, and Archived moves the workspace to S3 after 7 days.

**Yields.** A turn yields with `done`, `waiting_for_human` or `budget` and the session goes idle. A `time_slice` yield is the exception: the workflow continues as new and starts the next slice at once.

**Signals.** The workflow reacts to `userMessage`, `pause`, `resume`, `cancel`, `hitlResponse` and `presence`. A query returns the status, and an update confirms each message once it is in the log.

**Pausing one session.** Pause cancels the running turn, the harness checkpoints at the next safe point, and the pods are released. Other sessions don't notice, because each has its own workflow, pods and timers.

**Waking up.** From Idle, the next turn starts at once on the warm pods. From Suspended, the worker claims pods and restores the checkpoint; from Archived, it first unpacks the workspace from S3, so it takes longer.

**Timers.** 10 minutes and 7 days are defaults that each agent can change. Presence from SSH or a preview resets the idle timer.

**Ending.** Cancel ends a session from any state as Completed. An error that survives every retry ends it as Failed and notifies you.

## Durability

Any single pod can die mid-turn and the session continues. State lives in the event log, the workflow history, S3 and the workspace volume, never in a process.

| What dies | What happens | What is lost |
| --- | --- | --- |
| Harness pod mid-turn | The turn's stream breaks or its heartbeat stops, so Temporal retries the turn on a fresh pod from the last checkpoint | The model response in flight, which is generated again |
| Sandbox pod | agent-sandbox recreates it on the same PVC, and `sandboxd` restarts the dev servers in the services manifest | Running processes and `/tmp` |
| Worker | Another worker, or the restarted one, replays the workflow from its history | Nothing |
| Temporal server | Workflows stop moving and continue from Postgres when it returns | Nothing |
| Control plane API | Clients reconnect, and SSE resumes from the last sequence number | Nothing |
| Egress proxy | In-flight requests fail, and the tool returns an error the agent can retry | The request in flight |
| Postgres | Everything waits; CloudNativePG restarts it or restores from the S3 backups | Writes after the last archived WAL segment |
| The whole machine | k3s starts again, and sessions resume from Suspended | Nothing that was committed |
| Model API errors or rate limits | The turn retries with backoff; after repeated failures the session pauses and notifies you | Nothing |

**Retries never double work.** Every event carries an idempotency key made of session, turn and step, and the API drops duplicates. Each tool call has a call id, and `sandboxd` keeps recent results by id, so a retried call returns the first result instead of running twice.

**Overnight runs.** The harness works in slices of about 30 minutes, then checkpoints at a safe point and yields. The workflow continues as new, which keeps each history far below Temporal's limits of 51,200 events and 50 MB. The turn activity heartbeats every 10 seconds, so a dead worker costs a minute, not the night.

**Budgets.** Each session has a token, cost and wall-clock budget. Reaching it is a yield with reason `budget`, which asks you whether to continue.

## Control plane and API

One schema-first HTTP API owns every resource, and the backoffice console is the only interface people use on it. The console and the workers call it, and its schema generates the OpenAPI document and a typed client.

| Resource | Endpoints | Notes |
| --- | --- | --- |
| Agents | `/agents`, `/agents/:id/versions` | Every change is a new immutable version, and a session pins one |
| Sessions | `/sessions`, `/sessions/:id`, `/sessions/:id/pause`, `/resume`, `/cancel` | Creating a session starts the workflow `session/<id>` |
| Events | `/sessions/:id/events`, `/sessions/:id/messages` | Positional reads by sequence number; SSE with `Last-Event-ID` |
| Human in the loop | `/hitl`, `/hitl/:id/respond` | Answered from the console inbox |
| Memory | `/memory-stores`, `/memory-stores/:id/memories` | Versioned, with provenance and rollback |
| Evals | `/eval-cases`, `/eval-runs` | A case is saved from a session's events; a run replays cases as sessions and stores scores |
| Connectors | `/connectors` | Metadata in Postgres; secrets go straight to OpenBao and can't be read back |
| Access | `/sessions/:id/ssh`, `/sessions/:id/previews` | SSH keys and preview URLs |
| Harness | `/internal/sessions/:id/...` | Context, events and presigned checkpoint URLs for one session only |

**Auth.** The console uses local accounts with argon2id password hashes and an HTTP-only cookie. Scripts use hashed, scoped API tokens. The worker mints a short-lived token per session for the harness and `sandboxd`.

**Backoffice.** Agents are created and edited in the console, a React app built with Vite on the standard shadcn/ui theme (default tokens, light and dark). The agent form covers model, harness, sandbox template, system prompt, toolsets, connectors, memory stores, budget and reflection. Each save posts a new immutable version through the API; there is no YAML in Git and no CLI.

```json
// POST /agents, sent by the backoffice agent form
{
  "name": "frontend-dev",
  "model": "claude-opus-5-5",
  "harness": "deepagents",
  "sandboxTemplate": "node-web",
  "systemPrompt": "You build and test React apps in /workspace.",
  "toolsets": ["sandbox", "hitl", "memory"],
  "connectors": ["github", "linear"],
  "memoryStores": ["frontend-playbooks"],
  "budget": { "maxCostUsd": 20, "maxWallClock": "12h" },
  "reflection": { "autoApply": false }
}
```

## Session storage

Postgres holds the live event log and every record. S3 holds sealed transcript segments, workspace archives, checkpoints and backups.

**Postgres tables**

| Table | Holds | Notes |
| --- | --- | --- |
| `agents`, `agent_versions` | Agent definitions | Versions are immutable; every version comes from the API |
| `sessions` | One row per session | State, pinned agent version, harness kind, budget, workspace PVC |
| `session_events` | The event log | Append-only; key `(session_id, seq)`; JSONB payload; idempotency key |
| `harness_checkpoints` | Native harness state | S3 key, last sequence covered, harness kind |
| `hitl_requests` | Questions and approvals | Status, deadline, token hash, answer |
| `memory_stores`, `memories`, `memory_versions` | Memory | Path, content up to 100 KB, provenance |
| `reflections` | Reflection output | Lessons, proposed memory changes, score, status |
| `egress_audit` | Proxy decisions | Session, host, path, connector, verdict, bytes; never a secret |
| `users`, `api_tokens` | Accounts | argon2id hashes, token hashes, scopes |

**Object storage layout** (Garage buckets)

```text
transcripts/<agent>/<session>/<segment>.jsonl.zst   sealed event segments
workspaces/<session>/<timestamp>.tar.zst            archived /workspace
checkpoints/<session>/<seq>-<harness>.bin           native harness checkpoints
backups/postgres/...                                CloudNativePG Barman Cloud plugin
```

When a session suspends, its events up to the last checkpoint are sealed into a compressed JSONL segment. Postgres keeps those rows for 30 days, then only an index to the segment. `GET /sessions/:id/events?after=<seq>` reads from either place, so clients never notice.

&#91;embedded content: session storage · write, read and resume paths\]

1. **Write.** The harness posts canonical events in batches. The API drops any idempotency key it has seen, gives each new event the next `seq` for that session and commits the batch in one transaction.
2. **Seal.** When a session suspends, the worker copies its events up to the last checkpoint into one compressed JSONL segment in S3 and records the segment's key and last `seq` as an index row. The Postgres rows stay for 30 days, then only the index remains.
3. **Read.** `GET /sessions/:id/events?after=<seq>` finds which segments cover the range, streams them from S3, then continues with the Postgres rows after the last sealed `seq`. The console then switches to SSE and resumes with `Last-Event-ID` after a reconnect.
4. **Resume.** The worker starts a harness pod, which loads its latest checkpoint from S3 and reads only the events after that checkpoint's `seq` through the same read API.

Retention defaults: transcripts forever, workspace archives for 30 days after archiving, and the last three checkpoints per session.

**Canonical events.** Every harness writes the same event types, so the console, reflection and a harness switch work with any of them.

| Type | Payload |
| --- | --- |
| `user.message` | Text and attachments |
| `agent.message` | Text |
| `agent.thinking` | Thinking blocks, kept verbatim so a resumed turn can replay them |
| `tool.call` | Call id, tool name, input |
| `tool.result` | Call id, output, error flag, duration |
| `hitl.request` | Kind, question, options, urgency, deadline |
| `hitl.response` | The answer and who gave it |
| `session.status` | From, to and reason |
| `harness.checkpoint` | S3 key and the last sequence it covers |
| `usage` | Model, input, output and cache tokens, cost |
| `error` | Kind, message, whether it is retryable |

**Migrations and tests.** Migrations use `@effect/sql` with `@effect/sql-pg`. Unit tests run on PGlite, and integration tests run against CloudNativePG in the cluster.

## Harness

The harness is a thin, stateless runtime around one agent SDK. It runs model turns, calls tools in the sandbox and writes every step to the event log.

**Run protocol**

1. The worker claims a warm harness pod and calls `POST /run` with the session id, a session token, the budget and the slice length.
2. The runtime fetches the agent version, the memory index, the latest native checkpoint and the events after it.
3. The adapter runs until it yields, streaming canonical events to the API as they happen.
4. It checkpoints at a safe point, uploads through a presigned S3 URL and returns the yield reason: `done`, `waiting_for_human`, `budget`, `time_slice`, `paused` or `error`.

The pod holds no S3 or model credentials. Model calls leave through the egress proxy like every other request.

**Adapter contract**

```ts
export interface HarnessAdapter {
  readonly kind: "deepagents" | "pi-durable"
  run(input: {
    context: SessionContext              // agent version, tools, memory index
    checkpoint: Checkpoint | null        // native state, if any
    tail: ReadonlyArray<CanonicalEvent>  // events after the checkpoint
    slice: Duration.Duration             // yield at the next safe point after this
  }): Stream.Stream<CanonicalEvent, HarnessError>
  checkpoint(): Effect.Effect<Checkpoint, HarnessError>
}
```

**Two harnesses behind one flag**

| Harness | Package | How it runs | Native checkpoint | Tools | Status |
| --- | --- | --- | --- | --- | --- |
| deepagents (default) | `deepagents` (deepagentsjs, `createDeepAgent`) | In process | LangGraph state through a custom checkpointer | Sandbox MCP, HITL, memory | v1 |
| Pi Durable | `@earendil-works/pi-durable` | In process: a Harness opened over its own storage, one process per storage | Task checkpoints in a custom storage backend on Postgres | CodingTools read, write, edit and bash overridden by an extension whose env calls sandboxd | v1, behind the flag; experimental API |

OpenFeature evaluates the flag `harness.kind` through flagd when a session is created, with the agent and user as context. The result is pinned on the session and never changes mid-session. Moving a session to another harness forks it: the new harness rebuilds context from canonical events, without the old native state.

**Conformance suite.** Every adapter passes the same tests before it ships. They cover resume after a kill, checkpoint round trip, yield at the slice boundary, budget stop, HITL yield, tools only through the sandbox, event shapes and prefix stability.

**Warm pool.** One harness pod and one sandbox pod stay warm through `SandboxWarmPool`. A session claims one and the pool refills, and a dashboard compares time to first token warm against cold.

**Model settings**

- The default model is `claude-opus-5-5` with adaptive thinking, effort `medium` and streaming.
- Model calls authenticate with a Claude Console API key that you provide, stored as the anthropic connector. The credential lives in OpenBao and the egress proxy adds it, so harnesses only see a placeholder. No harness uses Claude's Agent SDK or a subscription login: Anthropic's terms reserve OAuth from every plan, Enterprise included, for Claude Code and its own apps, and point anything built on the API to Console keys or a cloud provider ([Claude Code legal and compliance](https://code.claude.com/docs/en/legal-and-compliance)).
- Prompt caching covers the system prompt, tools and history. Sessions that idle 5 to 60 minutes, such as HITL waits, use the 1-hour cache TTL.
- On wake, the worker warms the cache with a `max_tokens: 0` request in parallel with the pod claim. It matches the session's thinking and effort, and is sent without streaming because `max_tokens: 0` rejects `stream: true`.
- Long sessions use server-side compaction (`compact-2026-01-12`), context editing (`context-management-2025-06-27`) or the harness's own compaction. Each adapter declares which one it uses.
- Opus 5.5 costs $4 per million input tokens and $20 per million output tokens. Cache reads cost $0.20, and cache writes cost 1.25× input for 5 minutes or 2× for an hour.

**Prefix stability.** Opus 5.5 binds each thinking block to the exact prefix that produced it: system prompt, tools and earlier messages. A harness that rewrites any of them mid-session gets a 400 error and loses its cache. The conformance suite diffs consecutive request bodies to prove each adapter only appends.

Server-side compaction keeps the binding valid; history rewrites by the harness don't. The fallback is `thinking.block_binding.prefix_mismatch_behavior: "drop_block"` with the beta `thinking-binding-controls-2026-08-01`, which drops the stale thinking blocks. Enforcement is on by default for accounts created on or after 31 August 2026.

## Sandbox

Each session gets one sandbox pod with a persistent `/workspace` and a small daemon that serves the tools. Its only route out is the egress proxy.

**Image.** Debian slim with Node 24, pnpm, git, openssh-server, ripgrep, jq, curl and `sandboxd`, a TypeScript and Effect daemon. It runs as a non-root user on a read-only root filesystem. Only `/workspace` (the PVC) and `/tmp` are writable.

**Tools.** `sandboxd` serves the same tools two ways: MCP over streamable HTTP at `:7070/mcp`, and plain JSON at `:7070/v1/*` for adapters that call tools directly. Both need the per-session bearer token.

| Tool | What it does |
| --- | --- |
| `exec` | Runs a command, streams output, enforces a timeout, returns the exit code; keyed by call id |
| `process.start`, `stop`, `list`, `logs` | Long-running processes such as `pnpm dev`, kept between turns |
| `fs.read`, `write`, `edit`, `list`, `glob`, `grep` | File operations inside `/workspace` |
| `preview.expose(port)` | Registers a port and returns its preview URL |

**Workspace.** The PVC comes from the claim's volume template and survives pod restarts and suspension. A services manifest in the workspace lists dev servers, and `sandboxd` restarts them after a pod restart. On archive, the worker uploads `/workspace` as a tar.zst to S3 and deletes the PVC; on restore, an init container unpacks it.

**Memory.** Attached memory stores appear under `/memories`. Changes the agent makes there become new memory versions at the end of each turn.

**Presence.** `sandboxd` counts open SSH connections and preview activity and reports them to the worker. A session that someone is using never suspends for being idle.

**Isolation per environment**

| Environment | RuntimeClass | Isolation |
| --- | --- | --- |
| Mac mini M4 | `kata-clh` | A microVM per pod under Cloud Hypervisor, inside the Lima VM through nested virtualization |
| Laptop (M1 Pro) | `runc` | Plain containers, because the M1 has no nested virtualization |
| Cloud VPS | `gvisor` | A user-space kernel (`runsc` with systrap), because cheap VPSs don't expose KVM |

If the Kata spike fails on the Mac mini, it uses gVisor too. Firecracker through `kata-fc` is optional, because it needs the devmapper snapshotter.

**Network.** Every sandbox starts from deny-all. Egress goes only to the proxy and DNS. Ingress comes only from its own session's harness, the SSH gateway and the preview gateway, through a NetworkPolicy created with the claim.

**Example app.** `examples/react-basic` is Vite, React, TypeScript and Vitest. The first demo task is "Add a dark-mode toggle and make the tests pass."

## Egress and credentials

Every outbound request from a session leaves through one Go proxy. Policy decides whether it is blocked, passed through untouched, or opened so a credential from OpenBao can be added.

| Path | When | What the proxy does |
| --- | --- | --- |
| Deny | The host is not in the session's policy (the default) | Refuses the request and records the attempt |
| Passthrough | Allowed hosts that need no credential, such as the npm registry | Tunnels the TLS stream untouched, so it sees only the host and byte counts |
| Inject | Connector hosts (the GitHub and Linear MCP servers, `api.github.com`) and the model API | Terminates TLS with the cluster CA, swaps the placeholder for the real credential and re-encrypts upstream |

**How one request gets its credential**

1. The sandbox calls `https://api.github.com/user` with `Authorization: Bearer ph_github`, a placeholder from its environment.
2. The proxy maps the source pod IP to its session through a pod informer, then loads that session's `EgressPolicy`.
3. The route maps to the `github` connector. The proxy reads `connectors/github` from OpenBao and renders the header from the template.
4. It forwards the request, streams the response back and writes an audit row with session, host, path, method, connector, status and bytes. The secret is never logged.

**Policy as a CRD**

```yaml
apiVersion: platform.agents.local/v1alpha1
kind: EgressPolicy
metadata:
  name: frontend-dev
spec:
  passthrough:
    - registry.npmjs.org
    - codeload.github.com
  credentialed:
    - host: api.githubcopilot.com      # GitHub MCP server
      paths: ["/mcp/*"]
      connector: github
      header: "Authorization: Bearer {{ .token }}"
    - host: mcp.linear.app             # Linear MCP server
      paths: ["/mcp"]
      connector: linear
      header: "Authorization: Bearer {{ .apiKey }}"
    - host: api.github.com
      paths: ["/user", "/repos/EduardoSimon/*"]
      methods: [GET, POST, PATCH]
      connector: github
      header: "Authorization: Bearer {{ .token }}"
    - host: api.anthropic.com
      connector: anthropic
      header: "x-api-key: {{ .apiKey }}"
  rateLimit:
    requestsPerMinute: 120
```

**Trust and rotation.** Harness and sandbox pods trust the cluster CA through `NODE_EXTRA_CA_CERTS` and the system store. The proxy caches each secret for a short TTL, so a rotated credential takes effect without a restart.

**No way around it.** The pods set `HTTPS_PROXY`, but NetworkPolicy is what enforces the rule. A client that ignores the proxy variable simply can't connect anywhere.

**Identity hardening.** Source IP is enough for v1 on a single node. Later, pods send a projected service account token with audience `egress` in `Proxy-Authorization`, and the proxy checks it with TokenReview.

## Human in the loop

Agents reach you through three tools. A session that waits for an answer holds no pods, and your answer resumes it whether it comes in a minute or in three days.

| Tool | Use it for | Effect on the session |
| --- | --- | --- |
| `ask_human(question, options?, urgency)` | Missing information or a choice | Yields `waiting_for_human` and resumes with the answer |
| `request_approval(action, details)` | Risky actions; forced for any tool tagged `requires_approval` | Yields; approval runs the action, denial becomes the tool result |
| `notify(message, level)` | Progress or trouble you should know about | No yield; shows in the inbox |

**Flow**

1. The tool call becomes a `hitl.request` event and a row in `hitl_requests` with a deadline.
2. The workflow waits for a signal. After the idle timer, the pods are released.
3. The request shows in the console inbox, which you open from your phone over Tailscale. An option button or a free-text answer posts to `/hitl/:id/respond`.
4. The answer becomes a `hitl.response` event and a signal. The workflow claims pods, and the harness resumes with the answer as the tool result.
5. At the deadline, the tool returns `timed_out` and the agent decides what to do. High urgency sorts to the top of the inbox.

**Inbox.** The console lists open requests across all sessions, sorted by urgency and age. You can answer there instead of from the phone.

**When something is wrong.** Platform alerts land in the same inbox: failed or stuck sessions, budget hits, retry storms and bursts of denied egress. Telemetry lists them.

**Phone access.** You open the console on your phone over Tailscale. There is no push service, so requests and alerts wait in the inbox until you look.

## SSH and app previews

Every session has an SSH endpoint and preview URLs. Both find the session by name, check that you own it, and wake it if it is suspended.

**SSH**

- Connect with `ssh <session>@ssh.agents.edusimon.dev`. Locally, the gateway listens on port 2222.
- sshpiper's Kubernetes plugin routes by username, with one `Pipe` per running session pointing at its sandbox's sshd.
- Your public keys live in the control plane. sshpiper checks them, then uses its own key toward the sandbox, so sandboxes never see your keys.
- A suspended session has no `Pipe`. A catch-all `Pipe` sends you to `ssh-waker`, which prints a banner, resumes the session and asks you to reconnect in a few seconds. Holding the connection until the sandbox is ready is a stretch goal.
- An open connection counts as presence, so the session stays warm while you work.
- VS Code Remote SSH works with `remote.SSH.localServerDownload: always`, because the sandbox can't download the VS Code server itself.

**Previews**

- `preview.expose(5173)` registers a port. The app appears at `https://5173-<session>.preview.agents.edusimon.dev`, or `http://5173-<session>.preview.localhost` locally.
- Traefik, bundled with k3s, sends the wildcard host to `preview-gateway`. The gateway checks your console cookie, shows a "starting" page while a suspended session wakes, and proxies HTTP and WebSockets.
- WebSocket support keeps Vite hot reload working. The example app sets `server.allowedHosts: ['.preview.localhost', '.preview.agents.edusimon.dev']`, and `server.hmr.clientPort: 443` in the cloud.
- Preview requests and open WebSockets also count as presence.

**Domain and TLS.** Everything lives under `agents.edusimon.dev`: the console at the root, previews at `<port>-<session>.preview.agents.edusimon.dev` and SSH at `ssh.agents.edusimon.dev`. cert-manager gets wildcard certificates from Let's Encrypt with a DNS-01 challenge through Cloudflare, using cert-manager's built-in Cloudflare solver and an API token limited to DNS edit on edusimon.dev, so a new preview host needs no new certificate. The records are DNS-only (not proxied by Cloudflare) and point at the server's Tailscale IP, so the names resolve anywhere but only answer on your tailnet. Browsers force HTTPS on every `.dev` name, which this setup already does.

## Memory and learning

Agents improve across sessions in two ways. During a session they read and write memory stores; after it, a reflection step proposes lessons and playbooks.

**Memory stores**

- A store is a set of small text files, up to 100 KB each, with versions and provenance: session, turn and author.
- An agent attaches stores read-only or read-write. They appear under `/memories/<store>/` in the sandbox, and edits there become new versions at the end of each turn.
- Every write passes a secret scanner. A hit blocks the write and notifies you, and any version can be rolled back or redacted.
- The agent searches with `grep` first. A `memory.search` tool adds Postgres full-text search, then pgvector with embeddings computed in the cluster by transformers.js (bge-small or MiniLM on ONNX).

**Reflection**

- `ReflectWorkflow` runs as a child workflow when a session completes or is archived.
- It reads the transcript and writes lessons, playbook updates under `/memories/playbooks/`, facts about the codebase and a score for the session.
- Each agent sets `reflection.autoApply`. The default is off, so changes arrive in your inbox as a diff to approve. This blocks prompt injection from a web page or repo from poisoning memory.

**Measuring compounding**

- Eval cases come from traces. In the backoffice you open a session, pick the turn to test, and save it as a case: its starting message, agent version and workspace snapshot, plus a pass check (the repo's tests, expected tool calls, or a rubric a model grades). The ten example-app tasks are the first cases.
- An eval run replays a set of cases as ordinary sessions against a chosen agent version, from the UI. Run it with empty memory, then again after every batch of real sessions with reflection on, and compare runs side by side.
- Track success rate, turns, tokens, cost and wall-clock time per task, against the memory version that was live.
- A drop in the score points at the memory versions applied since the last good run, which can be rolled back together.

## Telemetry

Every service exports OpenTelemetry traces, metrics and logs to one otel-lgtm stack. One trace follows a turn from the API through the workflow, the harness and the sandbox to the egress.

**Instrumentation**

- Effect services use `@effect/opentelemetry`. The worker adds `@temporalio/interceptors-opentelemetry`, so workflow and activity spans join the same trace.
- Trace context travels in `traceparent` through `/run`, MCP calls and the proxy, which uses the Go OpenTelemetry SDK.
- Model calls follow the OpenTelemetry GenAI semantic conventions: model, input, output and cached tokens, finish reason and cost.
- Logs are structured JSON, and every line carries `session_id` and `trace_id`.

**Key numbers**

| Metric | Why it matters |
| --- | --- |
| Sessions by state | Capacity, and sessions stuck in one state |
| Time to first token, warm and cold | Shows what the warm pool buys |
| Pod claim latency, warm and cold | The same, per pod type |
| Turn duration and yields by reason | Health of the agent loop |
| Tokens and cost per session, agent and model | Spend |
| Cache hit ratio | Whether caching works |
| Egress decisions by host and verdict | Policy gaps and injection attempts |
| HITL wait time | How long agents block on you |
| Memory writes and reflection approvals | Learning activity |

**Alerts.** Grafana alerting sends these to the console inbox through a webhook:

- A session failed, or has run with no new events for 10 minutes.
- A session reached its budget.
- Retries or errors spike in one session.
- Denied egress spikes, which can signal prompt injection.
- The node runs low on memory or disk.
- A Postgres backup failed.

## Environments and deployment

One set of manifests runs in three places. Overlays change only isolation, sizes and hostnames.

|  | Mac mini M4, 16 GB (baseline) | Laptop, M1 Pro 16 GB | Cloud fake prod |
| --- | --- | --- | --- |
| Machine | Lima VM (`vmType: vz`, nested virtualization), Ubuntu arm64; 8 vCPUs and 12 GB, leaving 4 GB for macOS | The same Lima template without nested virtualization | Hetzner CAX21: 4 Arm vCPUs, 8 GB |
| Kubernetes | k3s | k3s | k3s, installed by cloud-init |
| Sandbox isolation | Kata (`kata-clh`) | runc | gVisor |
| Images | Built locally and imported into k3s | The same | GHCR, public, arm64 |
| Hostnames | `*.localhost` | `*.localhost` | agents.edusimon.dev |
| TLS | None | None | cert-manager with Let's Encrypt |
| Monthly cost | Electricity | — | About €12 |
| Up and down | `mise run cluster:up` | `mise run cluster:up laptop` | `mise run cloud:up`, `cloud:down` (OpenTofu) |

Every machine is arm64, so images build once with no cross-compiling.

**GitOps flow**

- Argo CD runs in each cluster in a minimal setup, without Dex, notifications or ApplicationSets. One app-of-apps points at the environment's overlay.
- Platform services always sync from `main`: CloudNativePG, Garage, Temporal, OpenBao, flagd, otel-lgtm, agent-sandbox and sshpiper.
- Inner loop: `mise run dev` builds our images, imports them into k3s and applies the local overlay for our apps. Auto-sync is off for those apps locally, so nothing needs a push while you review.
- Outer loop: after you merge a story, Argo CD syncs `main` everywhere.

**Fitting the cloud box.** The lean profile targets 8 GB. Story 4 measures the real numbers, and story 21 confirms them on the VPS.

| Component | Estimated MiB |
| --- | --- |
| k3s system | 700 |
| Argo CD | 450 |
| CloudNativePG and Postgres | 450 |
| Temporal | 350 |
| Garage, OpenBao and flagd | 280 |
| otel-lgtm | 900 |
| agent-sandbox, sshpiper and egress | 180 |
| Our services | 500 |
| Warm harness and warm sandbox | 900 |
| One active session | 1,000 |
| **Total** | **About 5,700** |

That leaves room for one or two active sessions. If it is too tight, the CAX31 with 16 GB costs about €21.50 a month.

**Cloud details.** The CAX21 is €10.49 a month plus about €0.50 for IPv4, though some October listings show €10.99. Postgres and Garage data sit on a small Hetzner volume of about €1, so the server itself can be rebuilt. CAX servers are sometimes out of stock; story 21 checks prices and stock before ordering.

Fallbacks: Netcup Arm at €22.62 a month for 16 GB on a 12-month term, or Oracle's Always Free Ampere tier. Oracle reportedly cut that tier to 2 OCPUs and 12 GB in June 2026, and capacity is hard to get.

## Decision log

Five decisions are yours and settled. The rest are my defaults, each with the point where we should look at it again.

**Your decisions**

| Decision | Choice | Why |
| --- | --- | --- |
| Session orchestration | Temporal, one workflow per session, with agent-sandbox for pods | Durable timers, signals and retries per session, with no operator to write |
| Postgres | CloudNativePG | Declarative, with backups to S3 |
| Language | TypeScript with Effect; Go only for the egress proxy | One language for API, worker, harness and tools; Go for a small, fast TLS proxy |
| Harness pods | Ephemeral pod per session, one always warm | Clean state per session, and the warm pod shows how fast starts can be |
| Environments | Mac mini M4 as the baseline; a cloud VPS at €10 to €20 a month | Real microVMs at home, a public endpoint for little money |

**My defaults**

| Decision | Choice | Revisit when |
| --- | --- | --- |
| Session topology | Separate harness and sandbox pods, one shared egress proxy | A per-session proxy becomes worth its memory |
| Sandbox isolation | Kata on the Mac mini, runc on the laptop, gVisor in the cloud | The Kata spike in story 2 reports |
| Object storage | Garage | It lacks an S3 feature we need |
| Secrets | OpenBao, KV v2 with Kubernetes auth | — |
| Feature flags | flagd with OpenFeature | — |
| Telemetry | grafana/otel-lgtm in one pod | Retention outgrows one pod |
| Cloud host | Hetzner CAX21 | It is out of stock, or 8 GB is too tight |
| Embeddings | transformers.js in the cluster | Retrieval quality is too low |

**Why Temporal over an operator**

|  | Temporal workflows | Custom Kubernetes operator |
| --- | --- | --- |
| Pause and resume one session | A signal | Patch the spec and reconcile |
| Wait days for a human | A workflow waits on a signal with no pods | Requeue loops and timers you build |
| Retries and heartbeats | Built in per activity | You build them |
| Testing | Time-skipping test environment | envtest, slower |
| Extra footprint | A server of about 350 MB plus a Postgres schema | None |
| Kubernetes view | Through the API and console | `kubectl get sessions` |
| Lock-in | The Temporal SDK in the worker | None |

Temporal wins on the hard parts: long waits, retries and per-session timers. CRDs stay for declarative config, and agent-sandbox manages the pods.

## Roadmap

&#91;embedded content: roadmap · 9 milestones, 23 issues\]

Stories go in issue order, one branch and one pull request each, and the next one starts after you merge. Story 21 can move up right after M4 if you want the public demo sooner.

The board is the [Agents Platform project](https://github.com/users/EduardoSimon/projects/2), and the code lives in [EduardoSimon/agents-platform](https://github.com/EduardoSimon/agents-platform). Both are public.

**How a story moves**

1. A branch off `main` named `story/<issue>-<slug>`.
2. Tests first, then the code, in small commits. Refactors get commits of their own.
3. `mise run check` passes: format, lint, types, tests and build.
4. When you say so, I push and open a pull request that closes the issue. You review the diff, I fix what you flag, and you merge.

**Stories**

| Issue | Story | Milestone |
| --- | --- | --- |
| [#1](https://github.com/EduardoSimon/agents-platform/issues/1) | Monorepo, toolchain and conventions | M0 Foundations |
| [#2](https://github.com/EduardoSimon/agents-platform/issues/2) | Mac mini cluster: Lima, k3s and the Kata microVM spike | M0 Foundations |
| [#3](https://github.com/EduardoSimon/agents-platform/issues/3) | GitOps bootstrap: Argo CD app-of-apps and the local loop | M0 Foundations |
| [#4](https://github.com/EduardoSimon/agents-platform/issues/4) | Stateful services: Postgres, S3, Temporal, OpenBao and flagd | M1 Platform services |
| [#5](https://github.com/EduardoSimon/agents-platform/issues/5) | Observability: otel-lgtm and the shared OpenTelemetry layer | M1 Platform services |
| [#6](https://github.com/EduardoSimon/agents-platform/issues/6) | Control-plane API and auth | M2 Session core |
| [#7](https://github.com/EduardoSimon/agents-platform/issues/7) | Session event log and S3 transcripts | M2 Session core |
| [#8](https://github.com/EduardoSimon/agents-platform/issues/8) | SessionWorkflow with a fake harness | M2 Session core |
| [#9](https://github.com/EduardoSimon/agents-platform/issues/9) | Agent create and versioning in the backoffice | M2 Session core |
| [#10](https://github.com/EduardoSimon/agents-platform/issues/10) | Sandbox image, sandboxd and the React example app | M3 Sandboxes and egress |
| [#11](https://github.com/EduardoSimon/agents-platform/issues/11) | agent-sandbox integration: templates, warm pools and archives | M3 Sandboxes and egress |
| [#12](https://github.com/EduardoSimon/agents-platform/issues/12) | Egress proxy with credential injection from OpenBao | M3 Sandboxes and egress |
| [#13](https://github.com/EduardoSimon/agents-platform/issues/13) | Harness runtime and deepagents: the first end-to-end run | M4 Harnesses |
| [#14](https://github.com/EduardoSimon/agents-platform/issues/14) | Pi Durable adapter behind the flag | M4 Harnesses |
| [#15](https://github.com/EduardoSimon/agents-platform/issues/15) | Console v1 and login | M5 Humans in the loop |
| [#16](https://github.com/EduardoSimon/agents-platform/issues/16) | Human in the loop: ask, approve and notify | M5 Humans in the loop |
| [#17](https://github.com/EduardoSimon/agents-platform/issues/17) | SSH into sandboxes, with wake on connect | M5 Humans in the loop |
| [#18](https://github.com/EduardoSimon/agents-platform/issues/18) | App preview URLs with hot reload | M5 Humans in the loop |
| [#19](https://github.com/EduardoSimon/agents-platform/issues/19) | Memory stores | M6 Learning |
| [#20](https://github.com/EduardoSimon/agents-platform/issues/20) | Reflection and measuring compounding | M6 Learning |
| [#21](https://github.com/EduardoSimon/agents-platform/issues/21) | Cloud fake prod on Hetzner for under €20 a month | M7 Cloud fake prod |
| [#22](https://github.com/EduardoSimon/agents-platform/issues/22) | Dashboards, alerts and cost accounting | M8 Operability |
| [#23](https://github.com/EduardoSimon/agents-platform/issues/23) | Resilience drills, backups and runbooks | M8 Operability |

## Risks

The two biggest risks are nested microVMs on the Mac mini and fitting everything in 8 GB. Each risk has a story that retires it early.

| Risk | Impact | Mitigation | Retired by |
| --- | --- | --- | --- |
| Kata inside Lima on the M4 is unstable; there are reports of hangs on an M4 Pro and of nested QEMU hanging | No microVMs at home | Spike first, prefer Cloud Hypervisor, fall back to gVisor | Story 2 |
| The 8 GB cloud box is too small | One session at a time, or OOM kills | Lean profile, measured early; CAX31 as the upgrade | Stories 4 and 21 |
| A harness rewrites its prompt prefix | 400 errors on Opus 5.5, cache misses, higher cost | Prefix test in the conformance suite; `drop_block` fallback | Story 13 |
| A harness SDK ignores `HTTPS_PROXY` | Its calls fail, because NetworkPolicy blocks them | Explicit proxy settings per adapter, covered by conformance tests | Stories 12 to 14 |
| Pi Durable's experimental API changes | Adapter rework; the second harness slips | Pin the version, keep it behind the flag, rerun conformance on each upgrade | Story 14 |
| A client pins certificates | Credential injection fails for that host | Passthrough for that host, without injection | Story 12 |
| Prompt injection poisons memory | Bad lessons spread to later sessions | Approval by default, provenance, rollback | Story 20 |
| Signals arrive during continue-as-new | A user message is lost | Drain signals before continuing; time-skipping tests | Story 8 |
| No CAX servers in stock | No cloud box | Other locations, then Netcup or Oracle | Story 21 |

&#32;

## Sources

Pages opened while writing this spec:

- [Vercel: a deep dive into Hive, Vercel's builds infrastructure](https://vercel.com/blog/a-deep-dive-into-hive-vercels-builds-infrastructure)
- [Stanislas: an overview of Firecracker](https://stanislas.blog/2021/08/firecracker/)
- [iximiuz Labs: how the playground infrastructure was built](https://labs.iximiuz.com/blog/iximiuz-labs-story)
- [Kubernetes blog: running agents on Kubernetes with Agent Sandbox](https://kubernetes.io/blog/2026/03/20/running-agents-on-kubernetes-with-agent-sandbox)
- [agent-sandbox: overview](https://agent-sandbox.sigs.k8s.io/docs/getting_started/overview/)
- [agent-sandbox: Firecracker sandbox example](https://agent-sandbox.sigs.k8s.io/docs/use-cases/examples/firecracker-sandbox/)
- [agent-sandbox: snapshots](https://agent-sandbox.sigs.k8s.io/docs/sandbox/snapshots/)
- [Encore: Firecracker on Apple Silicon](https://encore.dev/blog/firecracker-apple-silicon)
- [Earendil: Pi Durable](https://earendil.com/posts/pi-durable/)

Facts about Claude Managed Agents, Vercel Workflow, Temporal limits, sshpiper and provider prices came from web search results, not opened pages. Story 21 rechecks the prices before anything is ordered. Model, caching and thinking-binding details come from Anthropic's API reference notes bundled with Claude Code.
