import { defineConfig } from "vitest/config"

// Run by `mise run sandbox:smoke` against a built image; never part of `mise run test`.
export default defineConfig({
  test: {
    name: "sandbox-smoke",
    root: import.meta.dirname,
    include: ["smoke/**/*.smoke.test.ts"],
    // One container, shared by the tests in order.
    sequence: { concurrent: false },
    fileParallelism: false
  }
})
