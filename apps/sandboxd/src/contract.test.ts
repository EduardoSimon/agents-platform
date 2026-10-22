import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { type RunningServer, startServer } from "./testing.js"

const TOKEN = "test-token"
const TOOLS = [
  "exec",
  "fs.edit",
  "fs.glob",
  "fs.grep",
  "fs.list",
  "fs.read",
  "fs.write",
  "preview.expose",
  "process.list",
  "process.logs",
  "process.start",
  "process.stop"
]

type Outcome =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly status: number; readonly tag: string | undefined }

interface Adapter {
  readonly name: string
  readonly listTools: () => Promise<ReadonlyArray<string>>
  readonly call: (tool: string, input: object, token?: string | null) => Promise<Outcome>
}

const tagOf = (value: unknown): string | undefined =>
  typeof value === "object" && value !== null && "_tag" in value ? String(value._tag) : undefined

const jsonAdapter = (url: string): Adapter => ({
  name: "json",
  listTools: async () => {
    const res = await fetch(`${url}/v1/tools`, { headers: { authorization: `Bearer ${TOKEN}` } })
    return ((await res.json()) as Array<{ name: string }>).map((t) => t.name).sort()
  },
  call: async (tool, input, token = TOKEN) => {
    const res = await fetch(`${url}/v1/tools/${tool}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token === null ? {} : { authorization: `Bearer ${token}` })
      },
      body: JSON.stringify(input)
    })
    const body: unknown = await res.json().catch(() => undefined)
    return res.ok ? { ok: true, value: body } : { ok: false, status: res.status, tag: tagOf(body) }
  }
})

const mcpAdapter = (url: string): Adapter => {
  const connect = async (token: string | null) => {
    const client = new Client({ name: "contract", version: "0.0.0" })
    const headers: Record<string, string> =
      token === null ? {} : { authorization: `Bearer ${token}` }
    const transport = new StreamableHTTPClientTransport(new URL(`${url}/mcp`), {
      requestInit: { headers }
    })
    // The SDK types `sessionId` as optional-but-not-undefined, which exactOptionalPropertyTypes rejects.
    await client.connect(transport as Transport)
    return client
  }
  return {
    name: "mcp",
    listTools: async () => {
      const client = await connect(TOKEN)
      try {
        return (await client.listTools()).tools.map((t) => t.name).sort()
      } finally {
        await client.close()
      }
    },
    call: async (tool, input, token = TOKEN) => {
      let client: Client
      try {
        client = await connect(token)
      } catch (error) {
        const status = (error as { code?: number }).code
        return { ok: false, status: typeof status === "number" ? status : 0, tag: undefined }
      }
      try {
        const res = await client.callTool({
          name: tool,
          arguments: input as Record<string, unknown>
        })
        const text = (res.content as Array<{ type: string; text: string }>)[0]?.text ?? "null"
        const value: unknown = JSON.parse(text)
        return res.isError ? { ok: false, status: 200, tag: tagOf(value) } : { ok: true, value }
      } finally {
        await client.close()
      }
    }
  }
}

const until = async (check: () => Promise<boolean>) => {
  for (let i = 0; i < 100; i++) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error("condition not met in time")
}

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const waitForPort = async (adapter: Adapter, name: string): Promise<number> => {
  let port = 0
  await until(async () => {
    const out = await adapter.call("process.logs", { name })
    const match = /port=(\d+)/.exec((out as { value?: { content?: string } }).value?.content ?? "")
    port = Number(match?.[1] ?? 0)
    return port > 0
  })
  return port
}

let server: RunningServer
let workspace: string

beforeAll(async () => {
  workspace = await mkdtemp(join(tmpdir(), "sandboxd-ws-"))
  server = await startServer({ token: TOKEN, workspaceDir: workspace, port: 0 })
})

afterAll(async () => {
  await server.stop()
  await rm(workspace, { recursive: true, force: true })
})

const adapters = (): ReadonlyArray<Adapter> => [jsonAdapter(server.url), mcpAdapter(server.url)]

describe.each(["json", "mcp"] as const)("contract: %s transport", (name) => {
  const adapter = (): Adapter => adapters().find((a) => a.name === name) as Adapter

  it("lists every tool", async () => {
    expect(await adapter().listTools()).toEqual(TOOLS)
  })

  it("runs pnpm test in a fixture project through exec", async () => {
    const dir = join(workspace, `fixture-${name}`)
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ name: "fixture", private: true, scripts: { test: "node --test" } })
    )
    await writeFile(
      join(dir, "sum.test.js"),
      `import { test } from "node:test"\nimport assert from "node:assert"\ntest("sum", () => assert.equal(1 + 1, 2))\n`
    )
    const out = await adapter().call("exec", { command: "pnpm test", cwd: `fixture-${name}` })
    expect(out).toMatchObject({ ok: true, value: { exitCode: 0, timedOut: false } })
    expect((out as { value: { stdout: string } }).value.stdout).toContain("pass 1")
  }, 60_000)

  it("kills a command that exceeds timeoutMs", async () => {
    const out = await adapter().call("exec", { command: "sleep 30", timeoutMs: 300 })
    expect(out).toMatchObject({ ok: true, value: { timedOut: true } })
  })

  it("runs a command once for a repeated callId", async () => {
    const file = join(workspace, `once-${name}.txt`)
    const input = { command: `echo x >> once-${name}.txt`, callId: `once-${name}` }
    const [a, b] = await Promise.all([adapter().call("exec", input), adapter().call("exec", input)])
    const c = await adapter().call("exec", input)
    expect(a).toEqual(b)
    expect(a).toEqual(c)
    expect((await readFile(file, "utf8")).trim().split("\n")).toEqual(["x"])
  })

  it("supports the fs tools", async () => {
    const a = adapter()
    const p = `fs-${name}/a.txt`
    expect(
      await a.call("fs.write", { path: p, content: "hello world\nsecond needle\n" })
    ).toMatchObject({ ok: true })
    expect(await a.call("fs.read", { path: p })).toMatchObject({
      ok: true,
      value: { content: "hello world\nsecond needle\n" }
    })
    expect(
      await a.call("fs.edit", { path: p, oldString: "hello", newString: "bye" })
    ).toMatchObject({ ok: true })
    expect(await a.call("fs.edit", { path: p, oldString: "nope", newString: "x" })).toMatchObject({
      ok: false,
      tag: "EditNotFound"
    })
    expect(await a.call("fs.read", { path: p })).toMatchObject({
      value: { content: "bye world\nsecond needle\n" }
    })
    expect(await a.call("fs.list", { path: `fs-${name}` })).toMatchObject({
      ok: true,
      value: { entries: [{ name: "a.txt", type: "file" }] }
    })
    expect(await a.call("fs.glob", { pattern: `fs-${name}/*.txt` })).toMatchObject({
      ok: true,
      value: { paths: [p] }
    })
    expect(await a.call("fs.grep", { pattern: "needle", path: `fs-${name}` })).toMatchObject({
      ok: true,
      value: { matches: [{ path: p, line: 2, text: "second needle" }] }
    })
  })

  it("rejects an ambiguous fs.edit", async () => {
    const a = adapter()
    await a.call("fs.write", { path: `amb-${name}.txt`, content: "dup dup" })
    expect(
      await a.call("fs.edit", { path: `amb-${name}.txt`, oldString: "dup", newString: "x" })
    ).toMatchObject({ ok: false, tag: "EditAmbiguous" })
  })

  it("refuses paths outside the workspace", async () => {
    const a = adapter()
    const outside = await mkdtemp(join(tmpdir(), "sandboxd-out-"))
    await writeFile(join(outside, "secret.txt"), "secret")
    await symlink(outside, join(workspace, `escape-${name}`))
    for (const path of ["../etc/passwd", "/etc/passwd", `escape-${name}/secret.txt`]) {
      expect(await a.call("fs.read", { path })).toMatchObject({
        ok: false,
        tag: "PathOutsideWorkspace"
      })
    }
    expect(
      await a.call("fs.write", { path: `escape-${name}/new.txt`, content: "x" })
    ).toMatchObject({ ok: false, tag: "PathOutsideWorkspace" })
    expect(await a.call("exec", { command: "pwd", cwd: ".." })).toMatchObject({
      ok: false,
      tag: "PathOutsideWorkspace"
    })
    await rm(outside, { recursive: true, force: true })
  })

  it("keeps a process running between calls, then stops it", async () => {
    const a = adapter()
    const svc = `web-${name}`
    const command = `node -e "require('http').createServer((q,r)=>r.end('hi')).listen(0,'127.0.0.1',function(){console.log('port='+this.address().port)});setInterval(()=>{},1000)"`
    try {
      const started = await a.call("process.start", { name: svc, command })
      expect(started).toMatchObject({ ok: true, value: { name: svc, status: "running" } })
      const pid = (started as { value: { pid: number } }).value.pid
      const listed = await a.call("process.list", {})
      expect(listed).toMatchObject({ ok: true, value: { processes: [{ name: svc, pid }] } })
      const port = await waitForPort(a, svc)
      expect(await (await fetch(`http://127.0.0.1:${port}`)).text()).toBe("hi")
      // A later call still sees it running.
      expect(await a.call("process.list", {})).toMatchObject({
        value: { processes: [{ name: svc, status: "running" }] }
      })
      expect(await a.call("process.logs", { name: svc, tail: 1 })).toMatchObject({
        ok: true,
        value: { content: `port=${port}\n` }
      })
      expect(await a.call("process.start", { name: svc, command: "sleep 1" })).toMatchObject({
        ok: false,
        tag: "ProcessAlreadyRunning"
      })
      expect(await a.call("process.stop", { name: svc })).toMatchObject({
        ok: true,
        value: { name: svc }
      })
      expect(isAlive(pid)).toBe(false)
      expect(await a.call("process.list", {})).toMatchObject({
        ok: true,
        value: { processes: [] }
      })
      expect(await a.call("process.stop", { name: svc })).toMatchObject({
        ok: false,
        tag: "ProcessNotFound"
      })
    } finally {
      await a.call("process.stop", { name: svc })
    }
  })

  it("reads logs after an offset and records a failed start", async () => {
    const a = adapter()
    const svc = `logs-${name}`
    try {
      await a.call("process.start", { name: svc, command: "echo one; echo two; sleep 30" })
      let first: { content: string; offset: number } | undefined
      await until(async () => {
        const out = await a.call("process.logs", { name: svc })
        first = (out as { value: { content: string; offset: number } }).value
        return first.content === "one\ntwo\n"
      })
      expect(first?.offset).toBe(8)
      expect(await a.call("process.logs", { name: svc, since: 4 })).toMatchObject({
        value: { content: "two\n", offset: 8 }
      })
      expect(await a.call("process.logs", { name: "missing" })).toMatchObject({
        ok: false,
        tag: "ProcessNotFound"
      })
      expect(
        await a.call("process.start", {
          name: `bad-${name}`,
          command: "true",
          cwd: "nowhere/at/all"
        })
      ).toMatchObject({ ok: true, value: { status: "failed" } })
    } finally {
      await a.call("process.stop", { name: svc })
      await a.call("process.stop", { name: `bad-${name}` })
    }
  })

  it("exposes a preview URL", async () => {
    expect(await adapter().call("preview.expose", { port: 5173 })).toEqual({
      ok: true,
      value: { port: 5173, url: "https://5173-test.preview.local" }
    })
    expect(await adapter().call("preview.expose", { port: 0 })).toMatchObject({ ok: false })
  })

  it("answers 401 without a valid token", async () => {
    const a = adapter()
    expect(await a.call("fs.list", { path: "." }, null)).toMatchObject({ ok: false, status: 401 })
    expect(await a.call("fs.list", { path: "." }, "wrong")).toMatchObject({
      ok: false,
      status: 401
    })
  })
})

describe("contract: transports agree", () => {
  it("gives identical results for the same calls", async () => {
    const [json, mcp] = adapters() as [Adapter, Adapter]
    await json.call("fs.write", { path: "same/a.txt", content: "one\ntwo\n" })
    const calls: Array<[string, object]> = [
      ["fs.read", { path: "same/a.txt" }],
      ["fs.list", { path: "same" }],
      ["fs.glob", { pattern: "same/*.txt" }],
      ["fs.grep", { pattern: "two", path: "same" }],
      ["fs.read", { path: "../nope" }],
      ["exec", { command: "echo hi" }]
    ]
    for (const [tool, input] of calls) {
      const [a, b] = [await json.call(tool, input), await mcp.call(tool, input)]
      expect(b, tool).toEqual(a.ok ? a : { ...a, status: 200 })
    }
  })
})

describe("presence", () => {
  it("is bearer-protected and reports counters", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sandboxd-presence-"))
    const running = await startServer({ token: TOKEN, workspaceDir: dir, port: 0, sshPort: 1 })
    try {
      const get = (token?: string) =>
        fetch(`${running.url}/v1/presence`, {
          headers: token === undefined ? {} : { authorization: `Bearer ${token}` }
        })
      expect((await get()).status).toBe(401)
      expect(await (await get(TOKEN)).json()).toEqual({
        sshConnections: 0,
        previewLastActivityAt: null
      })
      await jsonAdapter(running.url).call("preview.expose", { port: 3000 })
      const body = (await (await get(TOKEN)).json()) as { previewLastActivityAt: string }
      expect(Number.isNaN(Date.parse(body.previewLastActivityAt))).toBe(false)
    } finally {
      await running.stop()
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe("restart", () => {
  it("starts services from the manifest again over the same workspace", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sandboxd-restart-"))
    let running = await startServer({ token: TOKEN, workspaceDir: dir, port: 0 })
    try {
      let api = jsonAdapter(running.url)
      const first = await api.call("process.start", {
        name: "svc",
        command: "echo boot >> boots.txt; sleep 60"
      })
      await api.call("process.start", { name: "gone", command: "sleep 60" })
      await api.call("process.stop", { name: "gone" })
      await api.call("process.start", { name: "broken", command: "true", cwd: "x" })
      await api.call("process.start", { name: "quick", command: "exit 3" })
      const oldPid = (first as { value: { pid: number } }).value.pid
      await running.stop()
      expect(isAlive(oldPid)).toBe(false)
      const manifest = JSON.parse(await readFile(join(dir, ".sandbox/services.json"), "utf8"))
      expect(manifest.map((s: { name: string }) => s.name).sort()).toEqual([
        "broken",
        "quick",
        "svc"
      ])

      running = await startServer({ token: TOKEN, workspaceDir: dir, port: 0 })
      api = jsonAdapter(running.url)
      const listed = (await api.call("process.list", {})) as {
        value: { processes: Array<{ name: string; status: string; pid?: number }> }
      }
      const byName = Object.fromEntries(listed.value.processes.map((p) => [p.name, p]))
      expect(Object.keys(byName).sort()).toEqual(["broken", "quick", "svc"])
      expect(byName.svc?.status).toBe("running")
      expect(byName.svc?.pid).not.toBe(oldPid)
      expect(byName.broken?.status).toBe("failed")
      await until(async () => {
        const again = (await api.call("process.list", {})) as typeof listed
        return again.value.processes.find((p) => p.name === "quick")?.status === "exited"
      })
      await until(
        async () => (await readFile(join(dir, "boots.txt"), "utf8")).split("\n").length === 3
      )
    } finally {
      for (const svc of ["svc", "broken", "quick"]) {
        await jsonAdapter(running.url).call("process.stop", { name: svc })
      }
      await running.stop()
      await rm(dir, { recursive: true, force: true })
    }
  })
})
