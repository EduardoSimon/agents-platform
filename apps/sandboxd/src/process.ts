import { spawn } from "node:child_process"
import { Effect } from "effect"
import { ToolIoError } from "./errors.js"

export interface RunOptions {
  readonly file: string
  readonly args: ReadonlyArray<string>
  readonly cwd: string
  readonly timeoutMs: number
  readonly maxOutputBytes: number
}

export interface RunResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
  readonly timedOut: boolean
}

const TRUNCATED = "\n[output truncated]"

/** Never hand the daemon's own credentials to a command the agent runs. */
const childEnv = (): NodeJS.ProcessEnv => {
  const { SANDBOXD_TOKEN: _token, ...rest } = process.env
  return rest
}

/**
 * Run a command in its own process group so a timeout (or interruption) kills the whole tree.
 * Output is capped per stream. A non-zero exit is a result, not a failure.
 */
export const runProcess = (options: RunOptions): Effect.Effect<RunResult, ToolIoError> =>
  Effect.async<RunResult, ToolIoError>((resume) => {
    const child = spawn(options.file, [...options.args], {
      cwd: options.cwd,
      env: childEnv(),
      detached: true,
      stdio: ["ignore", "pipe", "pipe"]
    })
    const killGroup = () => {
      if (child.pid === undefined) return
      try {
        process.kill(-child.pid, "SIGKILL")
      } catch {
        // already gone
      }
    }
    const collect = () => {
      let size = 0
      let truncated = false
      const chunks: Array<Buffer> = []
      return {
        push: (chunk: Buffer) => {
          if (size >= options.maxOutputBytes) {
            truncated = true
            return
          }
          const room = options.maxOutputBytes - size
          chunks.push(chunk.length > room ? chunk.subarray(0, room) : chunk)
          size += Math.min(chunk.length, room)
          truncated ||= chunk.length > room
        },
        text: () => Buffer.concat(chunks).toString("utf8") + (truncated ? TRUNCATED : "")
      }
    }
    const out = collect()
    const err = collect()
    let timedOut = false
    child.stdout.on("data", out.push)
    child.stderr.on("data", err.push)
    const timer = setTimeout(() => {
      timedOut = true
      killGroup()
    }, options.timeoutMs)
    child.on("error", (error) => {
      clearTimeout(timer)
      resume(
        Effect.fail(new ToolIoError({ message: `cannot run ${options.file}: ${error.message}` }))
      )
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      // Leftover background children must not outlive the call.
      killGroup()
      resume(
        Effect.succeed({ exitCode: code ?? -1, stdout: out.text(), stderr: err.text(), timedOut })
      )
    })
    return Effect.sync(() => {
      clearTimeout(timer)
      killGroup()
    })
  })
