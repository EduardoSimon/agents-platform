import { type ChildProcess, spawn } from "node:child_process"
import { closeSync, openSync } from "node:fs"
import { mkdir, open, readFile, rename, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { ProcessAlreadyRunning, ProcessNotFound, type ToolError, ToolIoError } from "./errors.js"
import { childEnv } from "./process.js"
import { Workspace } from "./workspace.js"

const MAX_LOG_BYTES = 1024 * 1024
const DEFAULT_TAIL_LINES = 100
const STOP_GRACE_MS = 3000

export const ProcessName = Schema.String.pipe(Schema.pattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/))

/** What the services manifest records and sandboxd starts again on boot. */
export const ServiceSpec = Schema.Struct({
  name: ProcessName,
  command: Schema.String,
  cwd: Schema.String,
  env: Schema.Record({ key: Schema.String, value: Schema.String })
})
export type ServiceSpec = typeof ServiceSpec.Type

export const ProcessInfo = Schema.Struct({
  name: Schema.String,
  command: Schema.String,
  cwd: Schema.String,
  status: Schema.Literal("running", "exited", "failed"),
  pid: Schema.optional(Schema.Int),
  exitCode: Schema.optional(Schema.Int),
  error: Schema.optional(Schema.String),
  startedAt: Schema.String
})
export type ProcessInfo = typeof ProcessInfo.Type

export interface LogsResult {
  readonly content: string
  /** Byte offset to pass as `since` to read what comes next. */
  readonly offset: number
}

export interface ProcessesService {
  readonly start: (spec: ServiceSpec) => Effect.Effect<ProcessInfo, ToolError>
  readonly stop: (name: string) => Effect.Effect<{ readonly name: string }, ToolError>
  readonly list: Effect.Effect<ReadonlyArray<ProcessInfo>>
  readonly logs: (
    name: string,
    options: { readonly tail?: number | undefined; readonly since?: number | undefined }
  ) => Effect.Effect<LogsResult, ToolError>
}

export class Processes extends Context.Tag("sandboxd/Processes")<Processes, ProcessesService>() {}

interface Entry {
  readonly spec: ServiceSpec
  readonly startedAt: string
  status: ProcessInfo["status"]
  pid?: number
  exitCode?: number
  error?: string
  child?: ChildProcess
  /** Settles when the shell exits or fails to spawn. */
  done: Promise<void>
}

const info = (entry: Entry): ProcessInfo => ({
  name: entry.spec.name,
  command: entry.spec.command,
  cwd: entry.spec.cwd,
  status: entry.status,
  startedAt: entry.startedAt,
  ...(entry.pid === undefined ? {} : { pid: entry.pid }),
  ...(entry.exitCode === undefined ? {} : { exitCode: entry.exitCode }),
  ...(entry.error === undefined ? {} : { error: entry.error })
})

const killGroup = (entry: Entry, signal: NodeJS.Signals) => {
  if (entry.pid === undefined) return
  try {
    process.kill(-entry.pid, signal)
  } catch {
    // group already gone
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** SIGTERM the group, wait for the shell, then SIGKILL whatever is left. */
const terminate = async (entry: Entry) => {
  killGroup(entry, "SIGTERM")
  if (entry.status === "running") await Promise.race([entry.done, sleep(STOP_GRACE_MS)])
  killGroup(entry, "SIGKILL")
  await entry.done
}

const failureMessage = (error: ToolError): string =>
  error._tag === "ToolIoError" ? error.message : error._tag

const decodeManifest = Schema.decodeUnknownOption(Schema.Array(ServiceSpec))

export const ProcessesLive = Layer.scoped(
  Processes,
  Effect.gen(function* () {
    const workspace = yield* Workspace
    const sandboxDir = join(workspace.root, ".sandbox")
    const manifestPath = join(sandboxDir, "services.json")
    const logPath = (name: string) => join(sandboxDir, "logs", `${name}.log`)
    const entries = new Map<string, Entry>()
    const lock = yield* Effect.makeSemaphore(1)

    const io = <A>(label: string, run: () => Promise<A>) =>
      Effect.tryPromise({
        try: run,
        catch: (error) =>
          new ToolIoError({
            message: `${label}: ${(error as NodeJS.ErrnoException).code ?? "io error"}`
          })
      })

    /** Atomic: write a sibling temp file, then rename over the manifest. */
    const persist = io("services manifest", async () => {
      const specs = [...entries.values()].map((entry) => entry.spec)
      await mkdir(sandboxDir, { recursive: true })
      const temp = `${manifestPath}.${process.pid}.tmp`
      await writeFile(temp, `${JSON.stringify(specs, null, 2)}\n`, "utf8")
      await rename(temp, manifestPath)
    })

    const launch = (spec: ServiceSpec): Effect.Effect<Entry, ToolError> =>
      Effect.gen(function* () {
        const cwd = yield* workspace.resolve(spec.cwd)
        const log = logPath(spec.name)
        yield* io(spec.name, () => mkdir(join(sandboxDir, "logs"), { recursive: true }))
        const entry: Entry = {
          spec,
          startedAt: new Date().toISOString(),
          status: "running",
          done: Promise.resolve()
        }
        const child = yield* Effect.try({
          try: () => {
            const fd = openSync(log, "a")
            try {
              // Detached with output in a file: the service outlives this call and its pipes.
              return spawn("sh", ["-c", spec.command], {
                cwd,
                env: { ...childEnv(), ...spec.env },
                detached: true,
                stdio: ["ignore", fd, fd]
              })
            } finally {
              closeSync(fd)
            }
          },
          catch: (error) =>
            new ToolIoError({ message: `cannot start ${spec.name}: ${(error as Error).message}` })
        })
        entry.child = child
        if (child.pid !== undefined) entry.pid = child.pid
        entry.done = new Promise<void>((resolve) => {
          child.once("error", (error) => {
            entry.status = "failed"
            entry.error = error.message
            resolve()
          })
          child.once("exit", (code, signal) => {
            if (entry.status === "running") entry.status = "exited"
            entry.exitCode = code ?? (signal === null ? -1 : 128)
            resolve()
          })
        })
        child.unref()
        return entry
      })

    // Boot: start every service from the manifest. One bad service must not stop the daemon.
    const manifest = yield* Effect.tryPromise(() => readFile(manifestPath, "utf8")).pipe(
      Effect.map((text) => decodeManifest(safeJson(text))),
      Effect.orElseSucceed(() => Option.none<ReadonlyArray<ServiceSpec>>())
    )
    for (const spec of Option.getOrElse(manifest, () => [])) {
      const entry = yield* launch(spec).pipe(
        Effect.catchAll((error) =>
          Effect.succeed<Entry>({
            spec,
            startedAt: new Date().toISOString(),
            status: "failed",
            error: failureMessage(error),
            done: Promise.resolve()
          })
        )
      )
      entries.set(spec.name, entry)
    }

    // Closing the server layer stops the children but keeps the manifest, so the next boot restores them.
    yield* Effect.addFinalizer(() =>
      Effect.promise(() => Promise.all([...entries.values()].map(terminate)))
    )

    const start = (spec: ServiceSpec) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          if (entries.get(spec.name)?.status === "running") {
            return yield* new ProcessAlreadyRunning({ name: spec.name })
          }
          const entry = yield* launch(spec)
          entries.set(spec.name, entry)
          yield* persist
          return info(entry)
        })
      )

    const stop = (name: string) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          const entry = entries.get(name)
          if (entry === undefined) return yield* new ProcessNotFound({ name })
          yield* Effect.promise(() => terminate(entry))
          entries.delete(name)
          yield* persist
          return { name }
        })
      )

    const logs = (
      name: string,
      options: { readonly tail?: number | undefined; readonly since?: number | undefined }
    ) =>
      Effect.tryPromise({
        try: async (): Promise<LogsResult> => {
          const file = await open(logPath(name), "r")
          try {
            const { size } = await file.stat()
            const from =
              options.since === undefined
                ? Math.max(0, size - MAX_LOG_BYTES)
                : Math.min(options.since, size)
            const length = Math.min(size - from, MAX_LOG_BYTES)
            const buffer = Buffer.alloc(length)
            await file.read(buffer, 0, length, from)
            const text = buffer.toString("utf8")
            if (options.since !== undefined) return { content: text, offset: from + length }
            const lines = text.split("\n")
            if (lines.at(-1) === "") lines.pop()
            const tail = lines.slice(-(options.tail ?? DEFAULT_TAIL_LINES))
            return { content: tail.length === 0 ? "" : `${tail.join("\n")}\n`, offset: size }
          } finally {
            await file.close()
          }
        },
        catch: (error): ToolError =>
          (error as NodeJS.ErrnoException).code === "ENOENT"
            ? new ProcessNotFound({ name })
            : new ToolIoError({ message: `${name}: cannot read logs` })
      })

    return Processes.of({
      start,
      stop,
      list: Effect.sync(() =>
        [...entries.values()].map(info).sort((a, b) => a.name.localeCompare(b.name))
      ),
      logs
    })
  })
)

const safeJson = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}
