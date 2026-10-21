import { Config, Context, Effect, Layer, Schema } from "effect"

export const Name = Schema.String.pipe(Schema.pattern(/^[a-z0-9-]+$/), Schema.brand("Name"))
export type Name = typeof Name.Type

export class InvalidName extends Schema.TaggedError<InvalidName>()("InvalidName", {
  input: Schema.String
}) {}

export class Greeter extends Context.Tag("Greeter")<
  Greeter,
  { readonly greet: (name: string) => Effect.Effect<string, InvalidName> }
>() {}

const greetWith = (prefix: string) => (name: string) =>
  Schema.decodeUnknown(Name)(name).pipe(
    Effect.mapError(() => new InvalidName({ input: name })),
    Effect.map((valid) => `${prefix}, ${valid}!`)
  )

/** Reads the greeting prefix through Config (rule 6), so building the layer can fail on a missing key. */
export const GreeterLive = Layer.effect(
  Greeter,
  Effect.gen(function* () {
    const prefix = yield* Config.string("GREETING_PREFIX")
    return Greeter.of({ greet: greetWith(prefix) })
  })
)

/** A fixed stub: no config and no I/O, so tests never depend on the environment. */
export const GreeterTest = Layer.succeed(Greeter, Greeter.of({ greet: greetWith("Hello") }))
