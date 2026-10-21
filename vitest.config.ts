import { defineConfig } from "vitest/config"

// "@agents-platform/source" resolves workspace packages to their src/, so tests run without a prior build.
export default defineConfig({
  resolve: { conditions: ["@agents-platform/source"] },
  test: {
    projects: [
      {
        extends: true,
        test: { name: "unit", include: ["{apps,packages}/*/src/**/*.test.ts"] }
      }
    ]
  }
})
