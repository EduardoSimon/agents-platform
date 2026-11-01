import react from "@vitejs/plugin-react"
import { defineConfig } from "vitest/config"

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    // Only src/: demo/ holds tests a demo copies in, which fail against the plain app.
    include: ["src/**/*.test.{ts,tsx}"]
  }
})
