import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, expect, it } from "vitest"
import { App } from "./App"

// The dark-mode demo copies this file into src/; it fails until the agent adds the toggle.
afterEach(() => {
  cleanup()
  document.documentElement.classList.remove("dark")
})

it("toggles dark mode on the document", () => {
  render(<App />)
  expect(document.documentElement.classList.contains("dark")).toBe(false)
  fireEvent.click(screen.getByRole("button", { name: "Dark mode" }))
  expect(document.documentElement.classList.contains("dark")).toBe(true)
  fireEvent.click(screen.getByRole("button", { name: "Light mode" }))
  expect(document.documentElement.classList.contains("dark")).toBe(false)
})
