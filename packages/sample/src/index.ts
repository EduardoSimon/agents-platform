import { Context, Effect, Layer, Schema } from "effect"

export const Name = Schema.String.pipe(Schema.pattern(/^[a-z0-9-]+$/), Schema.brand("Name"))
export type Name = typeof Name.Type

export class InvalidName extends Schema.TaggedError<InvalidName>()("InvalidName", {
  input: Schema.String
}) {}

export class Greeter extends Context.Tag("Greeter")<
  Greeter,
  { readonly greet: (name: string) => Effect.Effect<string, InvalidName> }
>() {}

const greet = (name: string) =>
  Schema.decodeUnknown(Name)(name).pipe(
    Effect.mapError(() => new InvalidName({ input: name })),
    Effect.map((valid) => `Hello, ${valid}!`)
  )

export const GreeterLive = Layer.succeed(Greeter, Greeter.of({ greet }))

/** Deterministic and free of I/O; swap in for anything that would touch the network. */
export const GreeterTest = Layer.succeed(Greeter, Greeter.of({ greet }))
