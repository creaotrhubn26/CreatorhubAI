# MCP integrations

Glimmer loads local stdio MCP servers from `config/mcp-servers.json`. The file
is intentionally gitignored and should remain owner-readable only (`0600`). A
secret-free template is available at `config/mcp-servers.example.json`.

## Curated defaults

- Context7 `4.0.3`: read-only library documentation.
- Playwright MCP `0.0.79`: isolated, headless browser automation. Tools marked
  write-capable by the server require Glimmer approval.
- GitHub MCP `1.11.0`: optional. The wrapper runs the pinned container with
  `GITHUB_READ_ONLY=1`, lockdown mode, and a bounded toolset. It reads the token
  from the authenticated GitHub CLI at process start and never stores it in the
  MCP config.

Context7 and Playwright use exact npm versions. GitHub never pulls implicitly:
start Docker and explicitly install the pinned image before enabling it:

```sh
docker pull ghcr.io/github/github-mcp-server:v1.11.0
```

## Permission boundary

The patched llama-server maps MCP `annotations.readOnlyHint=true` to
`permissions.write=false`. Missing or malformed annotations fail closed as
write-capable. `glimmer-engineer.py` then:

- offers only read-only MCP tools in architect mode;
- asks for approval before every write-capable MCP call;
- redacts all write-capable MCP argument values from logs and events.

Both startup scripts run `verify-llama-mcp-permissions.sh` before loading an MCP
config. Startup fails if the source patch is absent or the server binary is
older than the patched sources.

## Updating

Update the version in the Control integration definition, the example config,
and the wrapper (for GitHub), rebuild llama-server when the permission patch
changes, run both repositories' full quality suites, and repeat the live
`/tools` permission check before restarting the main model runtime.
