import { Context, Deferred, Effect, Exit, FiberId, Layer } from "effect"

export interface CallCacheService {
  /** Run `effect` once per key; concurrent and later duplicates get the first result. No key, no caching. */
  readonly once: <A, E, R>(
    key: string | undefined,
    effect: Effect.Effect<A, E, R>
  ) => Effect.Effect<A, E, R>
}

export class CallCache extends Context.Tag("sandboxd/CallCache")<CallCache, CallCacheService>() {}

export interface CallCacheOptions {
  readonly capacity: number
  readonly ttlMs: number
}

interface Entry {
  readonly deferred: Deferred.Deferred<unknown, unknown>
  readonly at: number
  settled: boolean
}

export const makeCallCache = (options: CallCacheOptions): CallCacheService => {
  // Map keeps insertion order, so the first entries are the oldest.
  const entries = new Map<string, Entry>()
  const prune = (now: number) => {
    for (const [key, entry] of entries) {
      const expired = now - entry.at > options.ttlMs
      const overCapacity = entries.size > options.capacity
      if (!entry.settled || (!expired && !overCapacity)) {
        if (!entry.settled) continue
        break
      }
      entries.delete(key)
    }
  }
  return {
    once: <A, E, R>(key: string | undefined, effect: Effect.Effect<A, E, R>) => {
      if (key === undefined) return effect
      return Effect.suspend(() => {
        const now = Date.now()
        prune(now)
        const hit = entries.get(key)
        if (hit !== undefined)
          return Deferred.await(hit.deferred as unknown as Deferred.Deferred<A, E>)
        const deferred = Deferred.unsafeMake<A, E>(FiberId.none)
        const entry: Entry = {
          deferred: deferred as Deferred.Deferred<unknown, unknown>,
          at: now,
          settled: false
        }
        entries.set(key, entry)
        return effect.pipe(
          Effect.onExit((exit) => {
            entry.settled = true
            // An interrupted run has no result worth replaying; let the next caller retry.
            if (Exit.isInterrupted(exit)) entries.delete(key)
            return Deferred.done(deferred, exit)
          })
        )
      })
    }
  }
}

export const CallCacheLive = (options: CallCacheOptions = { capacity: 1000, ttlMs: 10 * 60_000 }) =>
  Layer.succeed(CallCache, CallCache.of(makeCallCache(options)))
