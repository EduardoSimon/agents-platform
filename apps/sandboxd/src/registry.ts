import { Schema } from "effect"
import type { Effect } from "effect"
import type { CallCache } from "./call-cache.js"
import type { ToolError } from "./errors.js"
import type { Workspace } from "./workspace.js"

export type ToolRequirements = Workspace

export interface ToolDefinition<I extends Schema.Struct.Fields, O extends Schema.Schema.Any> {
  readonly name: string
  readonly description: string
  readonly input: Schema.Struct<I & { readonly callId: Schema.optional<typeof Schema.String> }>
  readonly output: O
  readonly handler: (
    input: Schema.Struct.Type<I & { readonly callId: Schema.optional<typeof Schema.String> }>
  ) => Effect.Effect<O["Type"], ToolError, ToolRequirements>
}

/** Type-erased view of a tool, which is all the transports need. */
export interface AnyTool {
  readonly name: string
  readonly description: string
  readonly input: Schema.Schema.AnyNoContext & { readonly fields: Schema.Struct.Fields }
  readonly output: Schema.Schema.AnyNoContext
  readonly handler: (input: never) => Effect.Effect<unknown, ToolError, ToolRequirements>
}

/** Every tool input accepts an optional `callId` so retried calls run once. */
export const defineTool = <I extends Schema.Struct.Fields, O extends Schema.Schema.Any>(spec: {
  readonly name: string
  readonly description: string
  readonly input: I
  readonly output: O
  readonly handler: (
    input: Schema.Struct.Type<I & { readonly callId: Schema.optional<typeof Schema.String> }>
  ) => Effect.Effect<O["Type"], ToolError, ToolRequirements>
}): ToolDefinition<I, O> => ({
  name: spec.name,
  description: spec.description,
  input: Schema.Struct({ ...spec.input, callId: Schema.optional(Schema.String) }),
  output: spec.output,
  handler: spec.handler
})

/** The one place a call runs, whatever transport it came in on. */
export const invoke = (
  tool: AnyTool,
  input: { readonly callId?: string | undefined },
  cache: CallCache["Type"]
) =>
  cache.once(
    input.callId === undefined ? undefined : `${tool.name}:${input.callId}`,
    tool.handler(input as never)
  )
