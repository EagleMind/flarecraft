# flarecraft

A topology tool for Cloudflare Workers architectures. Open a folder and the
whole system is mapped onto a canvas; design a new one and it is scaffolded to
disk. Every element is configured in place from Cloudflare's own field
reference, checked continuously, and deployable in dependency order.

The premise: on Cloudflare a whole architecture is a tiny declarative spec — N
Workers, each with a bindings list and triggers. You don't need static analysis
to recover the graph, you parse config and *have* it. That makes the graph both
renderable and editable, which isn't true on AWS or GCP.

## What the dashboard can't do

- **Reverse lookups.** Bindings are stored one-directional. It shows you
  Worker → queue, never queue → its producers and consumers.
- **A system view.** Every page is scoped to one resource. Nothing says which of
  your 40 Workers and 12 namespaces belong to the same application.
- **Design-time.** It only shows what already exists.

## Running it

```bash
pnpm install
```

Two processes, two terminals:

```bash
pnpm server
```

```bash
pnpm studio
```

Then open http://localhost:5173 and choose a folder. **That path needs no
credentials at all** — a Cloudflare token is only required for reading the live
account, drift, live traffic, and deploy.

Credentials live in `~/.flarecraft/config.json`, outside this repo:

```json
{
  "cloudflare": { "apiToken": "...", "accountId": "..." },
  "anthropic": { "apiKey": "..." }
}
```

A **read-only** Cloudflare token covers everything except deploy. The Anthropic
key is only for the prose-to-subgraph path, and can be skipped entirely if
`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, or an `ant auth login` profile is
already set up.

Both are read by the local server and used there. Neither reaches the browser.

## Documentation

- **[docs/product.md](docs/product.md)** — what it is, the gap it fills, who it
  is for, what it deliberately does not do, and an honest status
- **[docs/architecture.md](docs/architecture.md)** — the model, the packages,
  and the reasoning behind every notable decision
- **[docs/using-it.md](docs/using-it.md)** — setup and every workflow end to end

## Layout

```
packages/
  model/         SystemModel: nodes, edges, graph ops, mutations, refactors, deploy planning
  catalog/       primitives, legal connections, limits, the wrangler field reference
  wrangler-io/   config ↔ model, project scaffolding, BLUEPRINT.md
  account/       read-only Cloudflare REST client and GraphQL analytics
  rules/         lint rules and the config-vs-deployed diff
apps/
  studio/        React 19 + Vite + Tailwind 4 + React Flow canvas
  server/        local Hono server: credentials, filesystem, folder browsing, deploy
  mcp/           read-only MCP tools for a coding agent
```

Everything is a view of one `SystemModel`.

The server runs on **8798**, not 8787 — that's `wrangler dev`'s default, and
colliding with it would be a daily annoyance for this tool's users.

## From a coding agent

```bash
claude mcp add flarecraft -- npx tsx /absolute/path/to/flarecraft/apps/mcp/src/index.ts
```

Five read-only tools: `scan_repos`, `who_binds` (the reverse lookup),
`lint_topology`, `choose_primitive`, `diff_deployed`.

## Checks

```bash
pnpm test          # 158 unit tests
pnpm typecheck     # all four TypeScript projects
pnpm verify:emit   # emit a repo, run `wrangler deploy --dry-run` on each Worker
pnpm verify:mcp    # drive the MCP server over a real stdio transport
```

`verify:emit` is the one that matters most. Round-trip tests prove the model
survives; only wrangler proves it would deploy — and it has caught two emitter
bugs that every unit test missed.

## Status

Working and verified against real data: parser, lint engine, primitive chooser,
canvas with direct manipulation and undo/redo, inline configuration, project
scaffolding and the design → code → reload round trip, export, deploy planning,
drift, refactors, and the MCP server.

Not yet proven: deploy execution against a live account, the account scan's
endpoint paths, live traffic data, drift, and the prose-to-subgraph path — each
for a specific reason, listed in
[docs/product.md](docs/product.md#honest-status).

**The cost model was not built on purpose.** The topology knows structure, not
magnitudes, and encoding pricing from memory would print confident wrong numbers
into a tool people act on. Reasoning in
[docs/architecture.md](docs/architecture.md#the-cost-model-was-not-built).
