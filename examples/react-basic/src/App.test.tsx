import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, expect, it } from "vitest"
import { App } from "./App"

afterEach(cleanup)

it("counts clicks", () => {
  render(<App />)
  const button = screen.getByRole("button", { name: "Count: 0" })
  fireEvent.click(button)
  expect(button.textContent).toBe("Count: 1")
})
