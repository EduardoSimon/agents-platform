import { lstat, realpath } from "node:fs/promises"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { Context, Effect, Layer } from "effect"
import { SandboxdConfig } from "./config.js"
import { PathOutsideWorkspace, ToolIoError } from "./errors.js"

export interface WorkspaceService {
  /** Real path of the workspace root. */
  readonly root: string
  /** Resolve a caller path to a real path inside the workspace, following symlinks, or fail. */
  readonly resolve: (path: string) => Effect.Effect<string, PathOutsideWorkspace | ToolIoError>
  /** Path relative to the root, for output. */
  readonly relativize: (absolute: string) => string
}

export class Workspace extends Context.Tag("sandboxd/Workspace")<Workspace, WorkspaceService>() {}

const isInside = (root: string, candidate: string): boolean => {
  const rel = relative(root, candidate)
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))
}

const errnoCode = (error: unknown): string | undefined =>
  (error as NodeJS.ErrnoException | undefined)?.code

/** Real path of `path`; when it does not exist yet, the real path of its nearest existing ancestor plus the rest. */
const realpathAllowMissing = async (path: string): Promise<string | undefined> => {
  const missing: Array<string> = []
  let current = path
  for (;;) {
    try {
      return join(await realpath(current), ...missing.reverse())
    } catch (error) {
      if (errnoCode(error) !== "ENOENT") throw error
      // A dangling symlink would let a later write land wherever it points.
      const stats = await lstat(current).catch(() => undefined)
      if (stats?.isSymbolicLink()) return undefined
      const parent = dirname(current)
      if (parent === current) return undefined
      missing.push(current.slice(parent.length).replace(/^[\\/]+/, ""))
      current = parent
    }
  }
}

export const WorkspaceLive = Layer.effect(
  Workspace,
  Effect.gen(function* () {
    const { workspaceDir } = yield* SandboxdConfig
    const root = yield* Effect.tryPromise({
      try: () => realpath(workspaceDir),
      catch: () => new ToolIoError({ message: `workspace directory not found: ${workspaceDir}` })
    }).pipe(Effect.orDie)
    return Workspace.of({
      root,
      relativize: (absolute) => relative(root, absolute) || ".",
      resolve: (path) =>
        Effect.tryPromise({
          try: () => realpathAllowMissing(resolve(root, path)),
          catch: (error) =>
            new ToolIoError({ message: `cannot resolve ${path}: ${errnoCode(error) ?? "error"}` })
        }).pipe(
          Effect.flatMap((real) =>
            real !== undefined && isInside(root, real)
              ? Effect.succeed(real)
              : Effect.fail(new PathOutsideWorkspace({ path }))
          )
        )
    })
  })
)
