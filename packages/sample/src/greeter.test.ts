import { describe, expect, it } from "@effect/vitest"
import { ConfigProvider, Effect, Either, Layer } from "effect"
import { Greeter, GreeterLive, GreeterTest, InvalidName } from "./index.js"

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

  it.effect("live layer reads its greeting prefix from Config", () =>
    Effect.gen(function* () {
      const greeter = yield* Greeter
      const greeting = yield* greeter.greet("ada-lovelace")
      expect(greeting).toBe("Hi, ada-lovelace!")
    }).pipe(
      Effect.provide(GreeterLive),
      Effect.withConfigProvider(ConfigProvider.fromMap(new Map([["GREETING_PREFIX", "Hi"]])))
    )
  )

  it.effect("live layer fails to build when the prefix is missing", () =>
    Effect.gen(function* () {
      const built = yield* Effect.either(Layer.build(GreeterLive).pipe(Effect.scoped))
      expect(Either.isLeft(built)).toBe(true)
    }).pipe(Effect.withConfigProvider(ConfigProvider.fromMap(new Map())))
  )
})
