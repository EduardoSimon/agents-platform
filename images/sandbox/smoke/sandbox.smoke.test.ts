import { execFile } from "node:child_process"
import { readdir, readFile } from "node:fs/promises"
import { join, relative } from "node:path"
import { promisify, stripVTControlCharacters } from "node:util"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

const run = promisify(execFile)

const IMAGE = process.env.SANDBOX_IMAGE ?? "agents-platform/sandbox:dev"
// Suffixed with the issue id, so parallel runs and other stories never clash.
const NAME = "sandbox-smoke-lab-37"
const TOKEN = "smoke-token"
const EXAMPLE = join(import.meta.dirname, "../../../examples/react-basic")
const SKIPPED = new Set(["node_modules", "dist"])

interface ExecResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
  readonly timedOut: boolean
}

const docker = async (...args: Array<string>): Promise<string> =>
  (await run("docker", args, { maxBuffer: 16 * 1024 * 1024 })).stdout.trim()

const removeContainerAndVolume = async () => {
  await docker("rm", "-f", NAME).catch(() => undefined)
  await docker("volume", "rm", "-f", NAME).catch(() => undefined)
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

const until = async (what: string, check: () => Promise<boolean>, timeoutMs: number) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check().catch(() => false)) return
    await sleep(500)
  }
  throw new Error(`${what}: not ready after ${timeoutMs}ms`)
}

/** The host port is random, so read it back after every start. */
const baseUrl = async () => {
  const mapping = await docker("port", NAME, "7070/tcp")
  return `http://${mapping.split("\n")[0]}`
}

const waitForDaemon = async () => {
  const url = await baseUrl()
  await until(
    "sandboxd",
    async () =>
      (await fetch(`${url}/v1/tools`, { headers: { authorization: `Bearer ${TOKEN}` } })).ok,
    30_000
  )
  return url
}

let client: Client

const connect = async (url: string) => {
  client = new Client({ name: "sandbox-smoke", version: "0.0.0" })
  const transport = new StreamableHTTPClientTransport(new URL(`${url}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${TOKEN}` } }
  })
  // The SDK types `sessionId` as optional-but-not-undefined, which exactOptionalPropertyTypes rejects.
  await client.connect(transport as Transport)
}

const call = async <A>(name: string, args: Record<string, unknown>): Promise<A> => {
  const result = await client.callTool({ name, arguments: args }, undefined, {
    timeout: 600_000
  })
  const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? "null"
  if (result.isError) throw new Error(`${name} failed: ${text}`)
  return JSON.parse(text) as A
}

const exec = (command: string, cwd?: string) =>
  call<ExecResult>("exec", { command, timeoutMs: 600_000, ...(cwd === undefined ? {} : { cwd }) })

const exampleFiles = async (dir: string): Promise<Array<string>> => {
  const entries = await readdir(dir, { withFileTypes: true })
  const nested = await Promise.all(
    entries
      .filter((entry) => !SKIPPED.has(entry.name))
      .map((entry) =>
        entry.isDirectory()
          ? exampleFiles(join(dir, entry.name))
          : Promise.resolve([join(dir, entry.name)])
      )
  )
  return nested.flat()
}

const devServerUp = async () => (await exec("curl -sf http://127.0.0.1:5173/")).exitCode === 0

describe("sandbox image", () => {
  beforeAll(async () => {
    await removeContainerAndVolume()
    await docker("volume", "create", NAME)
    await docker(
      "run",
      "--detach",
      "--name",
      NAME,
      "--read-only",
      "--tmpfs",
      "/tmp",
      "--volume",
      `${NAME}:/workspace`,
      "--publish",
      "127.0.0.1::7070",
      "--env",
      `SANDBOXD_TOKEN=${TOKEN}`,
      IMAGE
    )
    await connect(await waitForDaemon())
  }, 60_000)

  afterAll(async () => {
    await client?.close().catch(() => undefined)
    await removeContainerAndVolume()
  }, 60_000)

  it("lists the tools over MCP", async () => {
    const names = (await client.listTools()).tools.map((tool) => tool.name)
    expect(names).toEqual(expect.arrayContaining(["exec", "fs.write", "process.start"]))
  })

  it("runs as non-root on a read-only root filesystem", async () => {
    const id = await exec("id -u")
    expect(id.exitCode).toBe(0)
    expect(id.stdout.trim()).not.toBe("0")
    expect((await exec("touch /smoke")).exitCode).not.toBe(0)
    expect((await exec("touch /usr/smoke")).exitCode).not.toBe(0)
    expect((await exec("touch /tmp/smoke && touch /workspace/smoke")).exitCode).toBe(0)
  })

  it("runs pnpm install and pnpm test in the example app", async () => {
    for (const file of await exampleFiles(EXAMPLE)) {
      await call("fs.write", {
        path: join("react-basic", relative(EXAMPLE, file)),
        content: await readFile(file, "utf8")
      })
    }
    const result = await exec("pnpm install --frozen-lockfile && pnpm test", "react-basic")
    expect(result, result.stdout + result.stderr).toMatchObject({ exitCode: 0, timedOut: false })
    expect(stripVTControlCharacters(result.stdout)).toMatch(/Tests\s+1 passed/)
  }, 660_000)

  it("starts pnpm dev again after a container restart", async () => {
    await call("process.start", { name: "dev", command: "pnpm dev", cwd: "react-basic" })
    await until("pnpm dev", devServerUp, 60_000)

    await client.close()
    await docker("restart", NAME)
    await connect(await waitForDaemon())

    await until("pnpm dev after restart", devServerUp, 60_000)
    const { processes } = await call<{ processes: Array<{ name: string; status: string }> }>(
      "process.list",
      {}
    )
    expect(processes).toContainEqual(expect.objectContaining({ name: "dev", status: "running" }))
  }, 180_000)
})
