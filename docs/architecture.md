# Architecture

Everything in flarecraft is a view of one data structure. Three importers write
into it, three exporters read out of it, and the analysis layers sit on top.

```
account API ─┐                      ┌─→ canvas render (React Flow)
folder parse ─┼─→  SystemModel  ─────┼─→ project on disk (configs, stubs, BLUEPRINT.md)
canvas edits ┘     (graph)          └─→ deploy plan → wrangler
                       │
                       ├─→ lint rules      (packages/rules)
                       ├─→ drift diff      (config vs deployed)
                       └─→ MCP tools       (agent surface)
```

## Packages

| Package | Responsibility |
|---|---|
| `packages/model` | `SystemModel`: nodes, edges, graph ops, cycle detection, mutations, refactors, deployment planning |
| `packages/catalog` | Primitive metadata, legal connections, platform limits, runtime types, the wrangler field reference, the primitive chooser |
| `packages/wrangler-io` | Config ↔ model, project scaffolding, blueprint generation. `/fs` subpath for disk access |
| `packages/account` | Read-only Cloudflare REST client and GraphQL analytics; account → model |
| `packages/rules` | Lint rules and the config-vs-deployed diff |
| `apps/studio` | React 19 + Vite + Tailwind 4 + React Flow canvas |
| `apps/server` | Local Hono server: credential custody, filesystem, folder browsing, deploy execution |
| `apps/mcp` | Read-only MCP tools for a coding agent |

Internal packages are consumed straight from source (`"main": "./src/index.ts"`).
Vite and Vitest compile TypeScript on the fly, so there is no build step between
packages during development.

### Where the interesting files are

| File | What it holds |
|---|---|
| `catalog/relations.ts` | Which edges are legal — drives the canvas, `connect()`, and the proposal validator |
| `catalog/config-schema.ts` | Every configurable wrangler field, with help text |
| `catalog/decision.ts` | The primitive chooser's scored rule table |
| `catalog/limits.ts` | Platform limits, each with a confidence flag |
| `wrangler-io/emit.ts` | Model → annotated JSONC |
| `wrangler-io/scaffold.ts` | The full project, with per-file ownership |
| `wrangler-io/blueprint.ts` | `BLUEPRINT.md` |
| `model/deployment.ts` | Ordered deploy plan |
| `model/refactors.ts` | Named refactors, each with a deploy plan |
| `rules/drift.ts` | Config versus deployed |
| `server/browse.ts` | Directory listing for the folder picker |
| `server/deploy.ts` | Plan execution |

---

## The model

### Nodes

Every distinct thing that can appear on the canvas: compute (Worker, Durable
Object, Workflow, Container), storage (KV, D1, R2, Vectorize, Hyperdrive,
Analytics Engine, Secrets Store), messaging (Queue), ingress (route, custom
domain, cron, email), platform services (AI, Browser Rendering, Images, dispatch
namespace, mTLS, rate limit), and opaque externals.

Deliberately **not** nodes: `assets`, `vars`, `version_metadata`. Those are
properties of a Worker rather than things a Worker talks to, and drawing them
turns every diagram into noise.

### Edges

Each edge carries two orthogonal facts, and keeping them separate is what makes
round-tripping work:

- **`kind`** — the structural role: `binding`, `service`, `queue_consumer`,
  `trigger`, `tail`. Lint rules, layout, and connection validation switch on this.
- **`bindingType`** — the wrangler config key it was read from. The emitter puts
  the binding back under the key it came from; writing it under the wrong one
  produces a config that parses and then does nothing.

Direction matters and is not always intuitive. A queue commonly has **both** a
producer edge (Worker → queue) and a consumer edge (queue → Worker), pointing
opposite ways.

### Where edited configuration lives

`Node.config` holds resource-level settings — a route's pattern, a cron
expression. `Edge.config` holds binding-entry settings — a queue producer's
`delivery_delay`, a D1 binding's `migrations_dir`.

Binding settings belong on the **edge** because the same resource bound by two
Workers can legitimately carry different settings in each. Both are kept apart
from `raw` so an edit stays distinguishable from what was parsed, and a re-scan
cannot silently revert it. At emit time `config` is applied *over* `raw`, so
editing one field never drops the rest of the entry.

### Identity

Node ids are **derived, not random**, so the same resource seen through
different importers collapses to one node. `resourceKey()` picks the identity
segment: for primitives that carry a Cloudflare-side id, that id wins;
otherwise the name does.

KV forces this. A `kv_namespaces` entry in a config has an `id` and a binding
variable, and **no namespace title at all** — while the account API knows the
title but is reached by id. Keying on the id is the only thing that makes a
folder parse and an account scan agree.

The corollary is `nameIsFallback`. When a config has no readable title, the
display name falls back to the binding variable, and the flag travels with the
node so merge precedence knows a real title must never be overwritten by a
stand-in. Found by a test, not by reasoning.

---

## Notable decisions

### The cost model was not built

Two independent reasons, either sufficient.

**The topology knows structure, not magnitudes.** It knows a Worker binds a D1
database. It does not know how many requests arrive, how many times per request
that binding is called, or — decisively — whether a query reads three rows or
three million. The terms that dominate a real Cloudflare bill are exactly the
ones config cannot see:

- **D1 rows read.** A missing index turns a one-row lookup into a full scan.
  Same topology, four orders of magnitude apart.
- **Durable Object duration.** WebSockets held without the Hibernation API bill
  wall-clock for every connected client, continuously. Same topology, same
  bindings.
- **Queue operations.** Retries multiply the count, and the retry rate is a
  property of the code and its upstreams.

A model would need the user to supply every significant input, at which point
the tool is a spreadsheet that happens to have a graph attached.

**The rates cannot be verified.** Pricing, tiers, and free allowances change.
Encoding them from memory into a tool that prints dollar figures produces
confident wrong numbers, and people act on those. This codebase already takes
the opposite position: `limits.ts` marks uncertain values `confidence: "verify"`,
and `canAssertLimit()` downgrades any rule citing one from error to warning. A
cost model is that problem at every output.

The honest version is **cost-shape analysis, not estimation**: "your bill will
be dominated by Durable Object wall-clock, here is why, here is the change that
fixes it." Derivable from topology, cites no dollar figures. Not built.

### Generated files have owners

`scaffoldProject` tags every file `owned` or not. flarecraft rewrites the owned
ones — configs, the typed `Env`, `provision.sh`, `BLUEPRINT.md` — on every sync,
and creates the rest exactly once.

This is what makes continuous syncing safe. The moment a scaffold overwrites a
handler somebody has edited, the tool has cost more than it gave, so the split
is enforced in code rather than left to a dialog nobody reads.

The companion is the `dirty` flag in the studio store: auto-sync fires only
after a canvas edit, never on load. Without it, merely opening a project would
rewrite its configs and take any hand-written comments with them.

### Deploy is two steps

`planDeployment` computes; `deploySystem` executes. They are separate endpoints
because this is the only part of flarecraft that writes to a Cloudflare account,
and creating billable resources on one unconfirmed click is not a convenience
worth having.

Execution is sequential and stops at the first failure. A half-deployed system
is bad; a half-deployed system that kept going and buried the error under six
more commands is worse.

Ordering is the substance: resources before the configs referencing them, and
Workers topologically sorted over service edges so a callee is always deployed
before its caller. A cycle has no correct order, so it is reported as a blocker
rather than resolved arbitrarily.

Id capture parses wrangler's stdout, which is not something to be proud of. The
alternative is write access to the account API — a much larger trust ask for the
same result. When a pattern does not match, the step is reported as needing
manual attention rather than guessed at.

### `REPLACE_ME` is not an id

The emitter writes a placeholder where a resource has no id yet. Read back
naively, that placeholder makes a resource that has never been created look like
it already exists — so the deploy plan skips it, the deploy fails, and the cause
is three steps from the symptom. Two resources both awaiting ids would also
collapse into one node.

So `PLACEHOLDER_ID` lives in the catalog and both the parser and `resourceKey`
treat it as absent. Found by reading a deploy plan that was missing a D1
database, not by a test.

### The folder picker is served, not native

`showDirectoryPicker()` returns a `FileSystemDirectoryHandle` whose `.name` is
the leaf folder and nothing more — there is no absolute path, deliberately.
`webkitdirectory` gives paths relative to the selection. Neither is usable here,
because the server reads the configs, writes the scaffold, and runs
`wrangler deploy` as a subprocess in that directory.

So `server/browse.ts` enumerates directories where they actually live. It reads
no file contents; it checks for the presence of a wrangler config or a
`BLUEPRINT.md` purely to label each entry — which turns a file tree into a list
of candidates you can choose between, something a native dialog could not offer.

Choosing a folder opens it immediately, and a folder that *is* one project opens
bound (syncable, deployable) while a folder of unrelated repositories is only
mapped. The difference is knowable from the folder itself, so it is decided
rather than asked about.

### The chooser is rule-based, not model-driven

`catalog/decision.ts` is a scored rule table. A recommendation you cannot audit
is worth very little when it is about to shape a system that is painful to
reverse, so every point scored carries the sentence that justifies it, and every
rejection names the constraint that ruled it out. It runs in the browser with no
API key, which makes the most valuable half of design assist free to run.

It is also deliberately **demoted in the UI**: the palette leads, and the
questionnaire sits behind "Not sure which to use?" — a question someone actually
asks, and only once they are already looking at the list.

### Model proposals are validated, never trusted

The prose path asks Claude for a subgraph, grounded on the catalog so it cannot
invent a primitive. Whatever comes back runs through the same `canConnect` the
canvas enforces. Illegal edges and unknown kinds are dropped **and shown**. The
guarantee that everything on the canvas is deployable only holds if a proposal
is checked rather than believed.

### Connection legality lives in the catalog, not the UI

`RELATIONS` drives React Flow's `isValidConnection`, the `connect()` mutation,
and the proposal validator. One table, three consumers — so the canvas, the
agent, and the design assistant cannot disagree about what Cloudflare permits.

The asymmetry in that table is real: **only Workers originate bindings.** A
Durable Object or Workflow runs inside a Worker's script and shares its env, so
its bindings belong to the defining Worker.

### The emitter preserves what it does not model

`Node.raw` holds the untouched source config. The emitter writes back what it
understands from typed fields and passes everything else through verbatim. That
is what makes model → config → model lossless without modelling all of
wrangler's surface area — `upload_source_maps` and `account_id` survive without
the exporter knowing what they are.

### Node geometry is declared, not measured

React Flow normally discovers node dimensions and handle positions with a
ResizeObserver, and `getEdgePosition` refuses to route an edge until it has
them. Every primitive node here is a fixed 210×62 with a target on the left edge
and a source on the right — `PrimitiveNode` hard-codes exactly that — so the
canvas declares `width`, `height`, `measured`, and `handles` outright.

`isNodeInitialized` accepts `node.handles` in place of a measurement, which is
React Flow's first-class path for geometry the author already knows. If a real
measurement lands, `internals.handleBounds` takes precedence; the declaration is
the floor, not a substitute.

This was originally misdiagnosed as an environment artefact — edges failed to
render in a backgrounded tab, and the first attempted fix called
`updateNodeInternals` inside `requestAnimationFrame`, which never fires while
the document is hidden. The fix looked wrong because it never ran.

### The server runs on 8798

Not 8787: that is `wrangler dev`'s default, and for this tool's audience a
collision with a locally running Worker is close to guaranteed.

### Credentials are resolved, not demanded

The Anthropic client is constructed bare when no key is configured, so the SDK's
own chain applies — `ANTHROPIC_API_KEY`, then `ANTHROPIC_AUTH_TOKEN`, then an
`ant auth login` profile. Requiring the key to be copied into flarecraft's
config would break a perfectly good profile.

There is a pre-flight check for whether *any* source exists, which duplicates a
little of that order. It earns its place: when nothing is configured the SDK
throws a plain `Error`, not one of its typed classes, so there is nothing to
catch on but message text. The check decides only whether to bother asking.

---

## Security posture

It is a personal tool on localhost, which lowers the stakes but not the standard.

- **Bound to 127.0.0.1.** There is no auth on these routes, so they must not be
  reachable from elsewhere.
- **Credentials never reach the browser.** The studio asks the server for a
  topology and gets a topology back. No endpoint returns a token, and no error
  message echoes one.
- **Reads are read-only.** Deploy is the sole write path, gated behind an
  explicit plan-then-run.
- **File writes are contained.** Export and scaffold both require an absolute
  destination and verify every emitted path resolves inside it before writing.
  Export additionally refuses a non-empty directory unless forced.
- **The folder browser lists directories only.** It never reads file contents.
- **Saved system names are restricted, not escaped.** They become filenames, and
  no legitimate design name needs a slash.

---

## Testing

158 tests across nine files. The parser corpus is eight real wrangler configs
vendored into `packages/wrangler-io/fixtures/`, chosen because each does
something a hand-written fixture would not have thought of: comments inside
arrays, a config with no `name`, a Durable Object class renamed across two
migration tags, an `env` overlay that redefines bindings.

Three scripts go beyond unit tests, and all three have earned it:

- **`pnpm verify:emit`** writes a designed system out and runs
  `wrangler deploy --dry-run` on every emitted Worker. It caught `ai` being
  emitted as an array where wrangler requires an object — which every
  round-trip test missed, because parsing our own wrong output happened to
  work — and later caught a route emitted as `{ pattern }`, which wrangler
  rejects without a `zone_id` or `zone_name`.
- **`pnpm verify:mcp`** drives the MCP server over a real stdio transport. It
  surfaced two different Hyperdrive resources rendering under the same fallback
  name.
- **`pnpm tsx scripts/demo-system.ts <folder>`** builds a small realistic system
  and scaffolds it, which is how the whole round trip gets exercised in one
  command.

The account scan is tested against a canned API. That proves the binding mapping
and the partial-failure handling; it does **not** prove the endpoint paths,
which only a live account can confirm. Those are marked `VERIFICATION` in
`packages/account/src`.
