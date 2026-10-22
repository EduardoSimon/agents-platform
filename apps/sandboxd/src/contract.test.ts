import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { type RunningServer, startServer } from "./testing.js"

const TOKEN = "test-token"
const TOOLS = ["exec", "fs.edit", "fs.glob", "fs.grep", "fs.list", "fs.read", "fs.write"]

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
