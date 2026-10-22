import { describe, expect, it } from "vitest"
import { countEstablished, readSshConnections } from "./presence.js"
import { renderPreviewUrl } from "./preview.js"

const HEADER =
  "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode"

// 0x0016 is port 22; st 01 is ESTABLISHED, 0A is LISTEN, 06 is TIME_WAIT.
const TCP4 = `${HEADER}
   0: 00000000:0016 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 1 1 0000000000000000 100 0 0 10 0
   1: 0100007F:0016 0100007F:D2F4 01 00000000:00000000 02:000A7C2B 00000000     0        0 2 2 0000000000000000 20 4 30 10 -1
   2: 0100007F:0016 0100007F:D2F6 01 00000000:00000000 02:000A7C2B 00000000     0        0 3 2 0000000000000000 20 4 30 10 -1
   3: 0100007F:0016 0100007F:D2F8 06 00000000:00000000 03:00000A2B 00000000     0        0 0 3 0000000000000000
   4: 0100007F:1F90 0100007F:D300 01 00000000:00000000 02:000A7C2B 00000000     0        0 4 2 0000000000000000 20 4 30 10 -1
`

const TCP6 = `${HEADER}
   0: 00000000000000000000000000000000:0016 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 5 1 0000000000000000 100 0 0 10 0
   1: 0000000000000000FFFF00000100007F:0016 0000000000000000FFFF00000100007F:D310 01 00000000:00000000 02:000A7C2B 00000000     0        0 6 2 0000000000000000 20 4 30 10 -1
`

describe("countEstablished", () => {
  it("counts only ESTABLISHED sockets on the port", () => {
    expect(countEstablished(TCP4, 22)).toBe(2)
    expect(countEstablished(TCP4, 8080)).toBe(1)
    expect(countEstablished(TCP6, 22)).toBe(1)
  })

  it("handles empty and malformed input", () => {
    expect(countEstablished("", 22)).toBe(0)
    expect(countEstablished(`${HEADER}\ngarbage\n\n`, 22)).toBe(0)
  })
})

describe("readSshConnections", () => {
  it("adds the IPv4 and IPv6 tables", async () => {
    const read = async (path: string) => (path.endsWith("tcp6") ? TCP6 : TCP4)
    expect(await readSshConnections(22, read)).toBe(3)
  })

  it("is 0 when /proc is missing", async () => {
    const read = async () => {
      throw Object.assign(new Error("nope"), { code: "ENOENT" })
    }
    expect(await readSshConnections(22, read)).toBe(0)
  })
})

describe("renderPreviewUrl", () => {
  it("fills port and session placeholders", () => {
    expect(
      renderPreviewUrl("https://{port}-{session}.preview.local", { port: 5173, session: "abc" })
    ).toBe("https://5173-abc.preview.local")
  })

  it("replaces every occurrence and leaves other text alone", () => {
    expect(
      renderPreviewUrl("http://h/{port}/{port}?s={session}&x={other}", { port: 1, session: "s" })
    ).toBe("http://h/1/1?s=s&x={other}")
  })
})
