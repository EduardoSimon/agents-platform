import { glob, mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import { dirname, isAbsolute } from "node:path"
import { Effect, Schema } from "effect"
import {
  EditAmbiguous,
  EditNotFound,
  PathNotFound,
  PathOutsideWorkspace,
  ToolIoError
} from "./errors.js"
import { runProcess } from "./process.js"
import { type AnyTool, defineTool } from "./registry.js"
import { Workspace } from "./workspace.js"

const DEFAULT_TIMEOUT_MS = 120_000
const MAX_TIMEOUT_MS = 600_000
const MAX_OUTPUT_BYTES = 1024 * 1024
const MAX_GREP_MATCHES = 1000

/** Map a node fs failure to a typed error. */
const io = <A>(path: string, run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (error) =>
      (error as NodeJS.ErrnoException).code === "ENOENT"
        ? new PathNotFound({ path })
        : new ToolIoError({
            message: `${path}: ${(error as NodeJS.ErrnoException).code ?? "io error"}`
          })
  })

const exec = defineTool({
  name: "exec",
  description:
    "Run a shell command in the workspace. Returns exit code, stdout, stderr and whether it timed out.",
  input: {
    command: Schema.String,
    cwd: Schema.optional(Schema.String),
    timeoutMs: Schema.optional(Schema.Int.pipe(Schema.between(1, MAX_TIMEOUT_MS)))
  },
  output: Schema.Struct({
    exitCode: Schema.Int,
    stdout: Schema.String,
    stderr: Schema.String,
    timedOut: Schema.Boolean
  }),
  handler: (input) =>
    Effect.gen(function* () {
      const workspace = yield* Workspace
      const cwd = yield* workspace.resolve(input.cwd ?? ".")
      return yield* runProcess({
        file: "sh",
        args: ["-c", input.command],
        cwd,
        timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxOutputBytes: MAX_OUTPUT_BYTES
      })
    })
})

const read = defineTool({
  name: "fs.read",
  description: "Read a UTF-8 text file in the workspace.",
  input: { path: Schema.String },
  output: Schema.Struct({ content: Schema.String }),
  handler: ({ path }) =>
    Effect.gen(function* () {
      const real = yield* (yield* Workspace).resolve(path)
      return { content: yield* io(path, () => readFile(real, "utf8")) }
    })
})

const write = defineTool({
  name: "fs.write",
  description: "Write a UTF-8 text file in the workspace, creating parent directories.",
  input: { path: Schema.String, content: Schema.String },
  output: Schema.Struct({ path: Schema.String, bytes: Schema.Int }),
  handler: ({ path, content }) =>
    Effect.gen(function* () {
      const workspace = yield* Workspace
      const real = yield* workspace.resolve(path)
      yield* io(path, () => mkdir(dirname(real), { recursive: true }))
      yield* io(path, () => writeFile(real, content, "utf8"))
      return { path: workspace.relativize(real), bytes: Buffer.byteLength(content) }
    })
})

const edit = defineTool({
  name: "fs.edit",
  description: "Replace one exact, unique occurrence of oldString with newString in a file.",
  input: { path: Schema.String, oldString: Schema.String, newString: Schema.String },
  output: Schema.Struct({ path: Schema.String, replacements: Schema.Int }),
  handler: ({ path, oldString, newString }) =>
    Effect.gen(function* () {
      const workspace = yield* Workspace
      const real = yield* workspace.resolve(path)
      const content = yield* io(path, () => readFile(real, "utf8"))
      const first = oldString === "" ? -1 : content.indexOf(oldString)
      if (first === -1) return yield* new EditNotFound({ path })
      const second = content.indexOf(oldString, first + oldString.length)
      if (second !== -1) {
        const occurrences = content.split(oldString).length - 1
        return yield* new EditAmbiguous({ path, occurrences })
      }
      const updated = content.slice(0, first) + newString + content.slice(first + oldString.length)
      yield* io(path, () => writeFile(real, updated, "utf8"))
      return { path: workspace.relativize(real), replacements: 1 }
    })
})

const EntryType = Schema.Literal("file", "directory", "symlink", "other")

const list = defineTool({
  name: "fs.list",
  description: "List the entries of a directory in the workspace.",
  input: { path: Schema.String },
  output: Schema.Struct({
    entries: Schema.Array(Schema.Struct({ name: Schema.String, type: EntryType }))
  }),
  handler: ({ path }) =>
    Effect.gen(function* () {
      const real = yield* (yield* Workspace).resolve(path)
      const dirents = yield* io(path, () => readdir(real, { withFileTypes: true }))
      const entries = dirents
        .map(
          (d) =>
            ({
              name: d.name,
              type: d.isFile()
                ? "file"
                : d.isDirectory()
                  ? "directory"
                  : d.isSymbolicLink()
                    ? "symlink"
                    : "other"
            }) as const
        )
        .sort((a, b) => a.name.localeCompare(b.name))
      return { entries }
    })
})

const globTool = defineTool({
  name: "fs.glob",
  description:
    "Find paths in the workspace matching a glob pattern relative to the workspace root.",
  input: { pattern: Schema.String },
  output: Schema.Struct({ paths: Schema.Array(Schema.String) }),
  handler: ({ pattern }) =>
    Effect.gen(function* () {
      const workspace = yield* Workspace
      if (isAbsolute(pattern) || pattern.split(/[\\/]/).includes("..")) {
        return yield* new PathOutsideWorkspace({ path: pattern })
      }
      const paths = yield* io(pattern, async () => {
        const found: Array<string> = []
        for await (const match of glob(pattern, { cwd: workspace.root })) found.push(match)
        return found.sort()
      })
      return { paths }
    })
})

const RgMatch = Schema.Struct({
  type: Schema.Literal("match"),
  data: Schema.Struct({
    path: Schema.Struct({ text: Schema.String }),
    lines: Schema.Struct({ text: Schema.String }),
    line_number: Schema.Int
  })
})
const decodeRgMatch = Schema.decodeUnknownOption(RgMatch)

const grep = defineTool({
  name: "fs.grep",
  description:
    "Search file contents with ripgrep under a workspace path. Returns path, line and text per match.",
  input: { pattern: Schema.String, path: Schema.optional(Schema.String) },
  output: Schema.Struct({
    matches: Schema.Array(
      Schema.Struct({ path: Schema.String, line: Schema.Int, text: Schema.String })
    )
  }),
  handler: ({ pattern, path }) =>
    Effect.gen(function* () {
      const workspace = yield* Workspace
      const real = yield* workspace.resolve(path ?? ".")
      const result = yield* runProcess({
        file: "rg",
        args: ["--json", "--", pattern, real],
        cwd: workspace.root,
        timeoutMs: DEFAULT_TIMEOUT_MS,
        maxOutputBytes: MAX_OUTPUT_BYTES
      })
      // rg exits 1 when nothing matched; 2 means a real error.
      if (result.exitCode > 1 || result.timedOut) {
        return yield* new ToolIoError({
          message: `rg failed: ${result.stderr.trim() || `exit ${result.exitCode}`}`
        })
      }
      const matches = result.stdout
        .split("\n")
        .flatMap((line) => {
          if (!line.startsWith("{")) return []
          const parsed = decodeRgMatch(safeJson(line))
          return parsed._tag === "None"
            ? []
            : [
                {
                  path: workspace.relativize(parsed.value.data.path.text),
                  line: parsed.value.data.line_number,
                  text: parsed.value.data.lines.text.replace(/\r?\n$/, "")
                }
              ]
        })
        .slice(0, MAX_GREP_MATCHES)
      return { matches }
    })
})

const safeJson = (line: string): unknown => {
  try {
    return JSON.parse(line)
  } catch {
    return undefined
  }
}

export const tools: ReadonlyArray<AnyTool> = [exec, read, write, edit, list, globTool, grep]
