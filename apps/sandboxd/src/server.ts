import { createHash, timingSafeEqual } from "node:crypto"
import { McpServer } from "@effect/ai"
import * as Tool from "@effect/ai/Tool"
import * as Toolkit from "@effect/ai/Toolkit"
import { HttpMiddleware, HttpRouter, HttpServerRequest, HttpServerResponse } from "@effect/platform"
import { Effect, Layer, Redacted, Schema } from "effect"
import { CallCache, CallCacheLive } from "./call-cache.js"
import { SandboxdConfig } from "./config.js"
import { ToolError, statusOf } from "./errors.js"
import { invoke } from "./registry.js"
import { tools } from "./tools.js"
import { Workspace, WorkspaceLive } from "./workspace.js"

const byName = new Map(tools.map((tool) => [tool.name, tool]))
const encodeToolError = Schema.encodeSync(ToolError)

const errorBody = (tag: string, message: string) => ({ _tag: tag, message })

// Digests have a fixed length, so the compare is constant-time whatever the caller sends.
const digest = (value: string) => createHash("sha256").update(value).digest()
const tokenMatches = (expected: string, header: string | undefined): boolean => {
  const supplied = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : ""
  return timingSafeEqual(digest(expected), digest(supplied))
}

/** Bearer-token check applied to every route, `/mcp` and `/v1/*` alike. */
const authenticate = (token: string) =>
  HttpMiddleware.make((app) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      if (!tokenMatches(token, request.headers.authorization)) {
        return HttpServerResponse.unsafeJson(
          errorBody("Unauthorized", "missing or invalid bearer token"),
          { status: 401 }
        )
      }
      return yield* app
    })
  )

/** JSON transport: derived from the registry, one route for every tool. */
const JsonRoutes = HttpRouter.Default.use((router) =>
  Effect.gen(function* () {
    const cache = yield* CallCache
    const workspace = yield* Workspace
    yield* router.get(
      "/v1/tools",
      HttpServerResponse.json(tools.map(({ name, description }) => ({ name, description })))
    )
    yield* router.post(
      "/v1/tools/:name",
      Effect.gen(function* () {
        const { name } = yield* HttpRouter.params
        const tool = name === undefined ? undefined : byName.get(name)
        if (tool === undefined) {
          return yield* HttpServerResponse.json(errorBody("UnknownTool", `no tool named ${name}`), {
            status: 404
          })
        }
        const request = yield* HttpServerRequest.HttpServerRequest
        const body = yield* request.json.pipe(Effect.orElseSucceed(() => undefined))
        const input = yield* Schema.decodeUnknown(tool.input)(body).pipe(Effect.either)
        if (input._tag === "Left") {
          return yield* HttpServerResponse.json(errorBody("InvalidInput", input.left.message), {
            status: 400
          })
        }
        const result = yield* invoke(tool, input.right, cache).pipe(
          Effect.provideService(Workspace, workspace),
          Effect.either
        )
        if (result._tag === "Left") {
          return yield* HttpServerResponse.json(encodeToolError(result.left), {
            status: statusOf(result.left)
          })
        }
        return yield* HttpServerResponse.json(yield* Schema.encode(tool.output)(result.right))
      }).pipe(
        Effect.catchAllDefect(() =>
          HttpServerResponse.json(errorBody("InternalError", "tool crashed"), { status: 500 })
        )
      )
    )
  })
)

/** MCP transport: the same registry, exposed as an `@effect/ai` toolkit. */
const aiTools = tools.map((tool) =>
  Tool.make(tool.name, {
    description: tool.description,
    parameters: tool.input.fields,
    success: tool.output,
    failure: ToolError
  })
)
const toolkit = Toolkit.make(
  ...(aiTools as [(typeof aiTools)[number]])
) as unknown as Toolkit.Toolkit<Record<string, Tool.Any>>

// The toolkit is built from the registry at runtime, so its handler types are erased; the cast restates
// what the handlers below actually need.
const McpTools = Layer.provide(
  McpServer.toolkit(toolkit),
  toolkit.toLayer(
    Effect.gen(function* () {
      const cache = yield* CallCache
      const workspace = yield* Workspace
      return Object.fromEntries(
        tools.map((tool) => [
          tool.name,
          (params: object) =>
            invoke(tool, params, cache).pipe(Effect.provideService(Workspace, workspace))
        ])
      )
    }) as never
  )
) as Layer.Layer<never, never, CallCache | Workspace>

/** Everything except the listening socket: provide an `HttpServer` and `SandboxdConfig` to run it. */
export const SandboxdApp = Layer.unwrapEffect(
  Effect.map(SandboxdConfig, ({ token }) =>
    HttpRouter.Default.serve(authenticate(Redacted.value(token)))
  )
).pipe(
  Layer.provide(JsonRoutes),
  Layer.provide(McpTools),
  Layer.provide(McpServer.layerHttp({ name: "sandboxd", version: "0.0.0", path: "/mcp" })),
  Layer.provide(Layer.mergeAll(WorkspaceLive, CallCacheLive()))
)
