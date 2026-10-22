import { createServer } from "node:http"
import { HttpServer } from "@effect/platform"
import { NodeHttpServer } from "@effect/platform-node"
import { Context, Effect, Exit, Layer, Redacted, Scope } from "effect"
import { SandboxdConfig } from "./config.js"
import { SandboxdApp } from "./server.js"

export interface RunningServer {
  readonly url: string
  readonly stop: () => Promise<void>
}

/** Start the daemon on `port` (0 for an OS-assigned port) and read the bound port back. */
export const startServer = async (options: {
  readonly token: string
  readonly workspaceDir: string
  readonly port: number
}): Promise<RunningServer> => {
  const layer = SandboxdApp.pipe(
    Layer.provideMerge(
      NodeHttpServer.layer(createServer, { port: options.port, host: "127.0.0.1" })
    ),
    Layer.provide(
      Layer.succeed(SandboxdConfig, {
        token: Redacted.make(options.token),
        workspaceDir: options.workspaceDir,
        port: options.port
      })
    )
  )
  const scope = Effect.runSync(Scope.make())
  const context = await Effect.runPromise(Layer.buildWithScope(layer, scope))
  const address = Context.get(context, HttpServer.HttpServer).address
  if (address._tag !== "TcpAddress") throw new Error("expected a TCP address")
  return {
    url: `http://127.0.0.1:${address.port}`,
    stop: () => Effect.runPromise(Scope.close(scope, Exit.void))
  }
}
