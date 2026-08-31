# What flarecraft is

A topology tool for Cloudflare Workers architectures. It opens a folder and maps
the whole system onto a canvas, lets you design new ones by direct manipulation,
configures every element in place from Cloudflare's own field reference,
scaffolds a real project on disk, and deploys it.

It runs locally, against one account, with no auth and no hosting.

---

## The gap it fills

The Cloudflare dashboard is a **resource registry, not a system view**. Three
consequences fall out of that, and all three are structural rather than
cosmetic:

**Bindings are stored one-directional.** A Worker's page shows you
`ORDERS_QUEUE → orders`. Open the queue `orders` and you cannot ask "who
produces to this, and who consumes it" — the reverse index does not exist in the
UI. So the question you always have while architecting, *what breaks if I change
this*, is unanswerable without grepping every repo you happen to have cloned.

**There is no "my system".** Every page is scoped to one object. You get a flat
list of 40 Workers, 12 KV namespaces, 6 queues, and nothing anywhere says which
of them belong to the same application.

**There is no design-time.** The dashboard can only show what already exists.
You cannot sketch what *should* exist, check it, and then materialise it — so
architecture happens in Excalidraw and gets hand-translated into config that
drifts within a week.

## Why this is buildable on Cloudflare and not elsewhere

A complete Cloudflare architecture is a **tiny declarative spec**: N Workers,
each with a bindings list plus triggers, and a handful of resource
declarations. A large real system is a few hundred lines of config.

That is radically unlike AWS, where architecture is CloudFormation plus IAM plus
VPC plus a thousand knobs, and recovering the graph needs static analysis and
guesswork. On Cloudflare you parse JSON and you *have* the graph, exactly.

Two things follow, and the whole product sits on them:

- The graph is **editable**, because adding an edge is adding a binding entry.
- The whole system **fits in a model's context window**, which is what makes the
  agent surface and the design assistant possible at all.

## Why now

The dashboard was adequate when systems grew at human speed. AI codegen
decoupled the growth rate of a system from anyone's comprehension of it. When
one person spawns fifteen Workers in a week, nobody holds the topology in their
head any more — and the platform's only answer is a flat alphabetical list.

---

## The loop

```
choose a folder ──► canvas ──► configure ──► deploy ──► observe
       ▲                                                    │
       └──────────── code it, come back, reload ◄────────────┘
```

| | |
|---|---|
| **Open** | Pick a folder; every wrangler config under it becomes one graph. Or read the live account |
| **Organize** | Group a scattered account into systems on the canvas, then save a group as one project folder |
| **Create** | A new project is scaffolded on disk immediately — configs, typed `Env`, handler stubs, `package.json`, `BLUEPRINT.md` |
| **Design** | Drag primitives on; illegal connections cannot be drawn |
| **Configure** | Click any element, edit its real wrangler fields in place |
| **Check** | Ten rules run continuously, rendering findings on the offending node |
| **Deploy** | Plan shows every command and why it sits where it does; Run executes them |
| **Observe** | Last 24h of requests and errors overlaid on the Workers themselves |
| **Reconcile** | Diff the configs against what is actually deployed |
| **Refactor** | Named topology changes that return a correctly ordered deploy plan |
| **Agent surface** | Five read-only MCP tools, so a coding agent can query the graph |

### The four things that carry it

**The canvas refuses impossible architectures.** Connection validity comes from
a catalog table wired into React Flow's `isValidConnection`. Try to wire a KV
namespace into a queue and the line will not land, with a reason: *"A KV
Namespace cannot connect to a Queue on Cloudflare."* That refusal is the
difference between a drawing tool and a design tool — it means anything on the
canvas corresponds to a real deployment.

**Configuration explains itself.** Fields come from Cloudflare's wrangler
reference, and each carries a line saying what it is *for*:

> **Keep dashboard vars** — `keep_vars`
> Off by default, which means a deploy wipes them — the usual cause of a
> binding vanishing in production.

Knowing `max_batch_timeout` is a number is not the hard part. Knowing it trades
latency for fewer invocations is.

**A project, not a diagram.** Creating a system writes a working folder
immediately. flarecraft regenerates the files that are a projection of the
topology and creates the rest exactly once — so your handlers are never
overwritten, and the round trip works: design here, code there, come back and
reload.

**A scattered account can be made into systems.** Mapping a live account
faithfully still leaves you looking at sprawl — the map is true and unhelpful,
because "which of these belong together" is exactly the fact Cloudflare does not
store. So the canvas lets you assert it: `Organize` suggests groups from the
connected components of the graph, Shift+drag corrects them, and a group's chip
saves it as one project folder with every member Worker's source copied in
beside a generated blueprint, ready to reopen bound.

That last step only ever **copies**. Your originals stay exactly where they are,
so the worst outcome of getting a grouping wrong is a folder you delete. And a
group whose Workers cannot all be located on disk **blocks** rather than
producing a project with an invented stub in it — the whole value of the output
is that it deploys.

**BLUEPRINT.md is the handoff.** flarecraft designs topology and never writes
business logic, which leaves a gap somebody has to cross. A wrangler config is a
poor brief for that; it says a Worker holds `env.ORDERS` but not what the Worker
is for, what reaches it, or what still has to be built. The blueprint says all
three, and is regenerated whenever the design changes so it cannot drift.

---

## Who it is for

Built as a **personal tool first**: one account, no auth, no multi-tenancy.

It earns its keep at roughly **ten or more nodes**. For a three-Worker app the
topology is obvious and the tool is overhead.

An honest note on that threshold: the corpus this was built against — eight
wrangler configs on the author's machine — is six *unrelated single-Worker
projects*, not one multi-service system. The map renders sparse against it. The
design and scaffold halves carry the value until systems exist that are large
enough for the mapping half to matter.

---

## What it deliberately does not do

**It does not write your business logic.** Design assist proposes *topology,
never code*. Scaffolding produces configs, a typed `Env`, and handler stubs
carrying only the entry points the topology implies — the handoff to Claude Code
or Cursor is the point, not a gap.

**It does not estimate costs.** See
[architecture.md](architecture.md#the-cost-model-was-not-built) for the full
reasoning: the topology knows structure, not magnitudes, and the terms that
dominate a real Cloudflare bill are precisely the ones config cannot see.

**It does not analyse your handler code.** Several of the best rules — a Durable
Object id derived from a constant, WebSockets held without the Hibernation API,
secrets used but never declared — need to read source, and the model is built
from config. A known gap, not an oversight.

**It does not touch your account without showing you first.** Every read is
read-only. Deploy is the single exception, and it is two steps on purpose: Plan
lists every command and why it is ordered that way, Run executes them. Creating
billable resources behind one unconfirmed click is not a convenience worth
having.

**It does not overwrite your files.** Configs, the typed `Env`, `provision.sh`,
and `BLUEPRINT.md` are regenerated on every sync. Handlers, `package.json`,
`tsconfig`, migrations, and the README are written once and never touched again.

---

## Honest status

Working and verified against real data: the parser (36 tests over eight real
configs), the lint engine, the primitive chooser, the canvas with direct
manipulation and undo/redo, inline configuration, project scaffolding, export
(proven with `wrangler deploy --dry-run`), the deploy planner, the drift diff,
refactor deploy plans, the MCP server (driven over a real stdio transport), and
grouping and consolidation. 180 tests, four TypeScript projects, all clean.

Consolidation is verified against the real folders on this machine: the sources
come out byte-for-byte identical, the copies exclude `node_modules` and `.git`,
and every copied Worker passes `wrangler deploy --dry-run`.

The round trip is verified end to end: create a project, hand-edit a config on
disk, reload — the canvas picked up a hand-added KV binding and recomputed the
deploy plan.

Not yet proven, and each for a specific reason:

- **Deploy has never run against a live account.** The plan is verified; the
  executor is not, because this machine has no Cloudflare token. Its id capture
  parses wrangler's stdout, which is the part to trust least — when it cannot
  read an id it stops and says which one to paste rather than leaving a config
  that silently will not deploy.
- **The account scan's endpoint paths.** Tested against a canned API, which
  proves the binding mapping and the partial-failure handling, not the URLs.
- **Live activity** reaches Cloudflare's GraphQL API and reports back, but has
  never returned real data here — with no token it says so rather than showing
  zeros.
- **Drift.** Both halves are tested independently; no real diff has run.
- **The prose-to-subgraph path.** Request shape, schema, and the validator are
  tested; no proposal has come back from the API, for want of credentials.
- **Grouping never round-trips.** Cloudflare has no concept of a group, so it is
  local metadata: it lives in the saved system and in the consolidated folder,
  and a fresh account scan alone cannot recover it. Not a gap to be closed —
  there is nowhere on the platform to put it.
- **The account/local join is by Worker name.** A Worker deployed under a name
  that differs from its config's `name` will not match, and shows as having no
  local folder. The block rule turns that into a prompt to locate it rather than
  a silent gap, but the join itself stays a heuristic.
- **Several platform limits** in `packages/catalog/src/limits.ts` are marked
  `confidence: "verify"`. Rules citing them downgrade themselves to warnings
  rather than asserting a threshold the code cannot stand behind.
