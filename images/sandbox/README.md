# sandbox image

The tool sandbox: sandboxd on Debian slim with Node 24, pnpm, git, openssh-server, ripgrep, jq and curl. It runs as `sandbox` (UID 10001) and expects a read-only root: only `/workspace` and `/tmp` are writable, HOME and caches live under `/tmp`, the pnpm store under `/workspace/.sandbox/pnpm-store`.

```sh
docker build -f images/sandbox/Dockerfile -t agents-platform/sandbox:dev .
docker run --read-only --tmpfs /tmp -v <volume>:/workspace -p 127.0.0.1::7070 \
  -e SANDBOXD_TOKEN=<token> agents-platform/sandbox:dev
```

`mise run sandbox:smoke` builds the image and runs `smoke/` against a container: MCP tools, non-root and read-only checks, `pnpm install && pnpm test` in `examples/react-basic`, and `pnpm dev` coming back after `docker restart`. It needs Docker and is not part of `mise run check`.
