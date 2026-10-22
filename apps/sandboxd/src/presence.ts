import { readFile } from "node:fs/promises"
import { Context, Effect, Layer } from "effect"
import { SandboxdConfig } from "./config.js"
import { renderPreviewUrl } from "./preview.js"

const TCP_ESTABLISHED = "01"

/**
 * Count ESTABLISHED sockets whose local port is `port` in a `/proc/net/tcp` or `tcp6` table.
 * Columns: `sl local_address rem_address st ...`, with addresses as `HEXADDR:HEXPORT`.
 */
export const countEstablished = (table: string, port: number): number =>
  table
    .split("\n")
    .slice(1)
    .filter((line) => {
      const fields = line.trim().split(/\s+/)
      const local = fields[1]
      if (local === undefined || fields[3] !== TCP_ESTABLISHED) return false
      return Number.parseInt(local.slice(local.lastIndexOf(":") + 1), 16) === port
    }).length

/** SSH connections to `port`; 0 where `/proc` is missing (macOS). */
export const readSshConnections = async (
  port: number,
  read: (path: string) => Promise<string> = (path) => readFile(path, "utf8")
): Promise<number> => {
  const counts = await Promise.all(
    ["/proc/net/tcp", "/proc/net/tcp6"].map((path) =>
      read(path).then(
        (table) => countEstablished(table, port),
        () => 0
      )
    )
  )
  return counts.reduce((a, b) => a + b, 0)
}

export interface PresenceSnapshot {
  readonly sshConnections: number
  readonly previewLastActivityAt: string | null
}

export interface PresenceService {
  readonly snapshot: Effect.Effect<PresenceSnapshot>
  /** Register a port and return its preview URL. Counts as preview activity. */
  readonly expose: (port: number) => Effect.Effect<string>
  /** Hook for the preview gateway (#18) to report traffic. */
  readonly recordPreviewActivity: Effect.Effect<void>
}

export class Presence extends Context.Tag("sandboxd/Presence")<Presence, PresenceService>() {}

export const PresenceLive = Layer.effect(
  Presence,
  Effect.gen(function* () {
    const { previewUrlTemplate, sessionId, sshPort } = yield* SandboxdConfig
    const exposed = new Set<number>()
    let lastActivity: Date | undefined
    const recordPreviewActivity = Effect.sync(() => {
      lastActivity = new Date()
    })
    return Presence.of({
      snapshot: Effect.promise(() => readSshConnections(sshPort)).pipe(
        Effect.map((sshConnections) => ({
          sshConnections,
          previewLastActivityAt: lastActivity?.toISOString() ?? null
        }))
      ),
      expose: (port) =>
        Effect.suspend(() => {
          exposed.add(port)
          return recordPreviewActivity.pipe(
            Effect.as(renderPreviewUrl(previewUrlTemplate, { port, session: sessionId }))
          )
        }),
      recordPreviewActivity
    })
  })
)
