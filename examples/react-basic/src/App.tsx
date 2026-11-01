import { useState } from "react"

export function App() {
  const [count, setCount] = useState(0)
  return (
    <main>
      <h1>react-basic</h1>
      <button type="button" onClick={() => setCount((n) => n + 1)}>
        Count: {count}
      </button>
    </main>
  )
}
