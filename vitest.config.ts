import { defineConfig } from "vitest/config"

// "source" resolves workspace packages to their src/, so tests run without a prior build.
export default defineConfig({
  resolve: { conditions: ["source"] },
  test: {
    projects: [
      {
        extends: true,
        test: { name: "unit", include: ["{apps,packages}/*/src/**/*.test.ts"] }
      }
    ]
  }
})
