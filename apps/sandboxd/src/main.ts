import { createServer } from "node:http"
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import { SandboxdConfig, settingsFromEnv } from "./config.js"
import { SandboxdApp } from "./server.js"

const Main = Layer.unwrapEffect(
  Effect.gen(function* () {
    const settings = yield* settingsFromEnv
    return SandboxdApp.pipe(
      Layer.provide(NodeHttpServer.layer(createServer, { port: settings.port })),
      Layer.provide(Layer.succeed(SandboxdConfig, settings))
    )
  })
)

NodeRuntime.runMain(Layer.launch(Main))
