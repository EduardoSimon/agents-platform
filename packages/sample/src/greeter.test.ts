import { describe, expect, it } from "@effect/vitest"
import { Effect, Either } from "effect"
import { Greeter, GreeterTest, InvalidName } from "./index.js"

describe("Greeter", () => {
  it.effect("greets a valid name", () =>
    Effect.gen(function* () {
      const greeter = yield* Greeter
      const greeting = yield* greeter.greet("ada-lovelace")
      expect(greeting).toBe("Hello, ada-lovelace!")
    }).pipe(Effect.provide(GreeterTest))
  )

  it.effect("fails with a typed InvalidName error", () =>
    Effect.gen(function* () {
      const greeter = yield* Greeter
      const result = yield* Effect.either(greeter.greet("Not Valid"))
      expect(Either.isLeft(result) && result.left).toBeInstanceOf(InvalidName)
    }).pipe(Effect.provide(GreeterTest))
  )
})
