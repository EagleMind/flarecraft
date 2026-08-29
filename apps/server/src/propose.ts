import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { canConnect, PRIMITIVES, RELATIONS } from "@flarecraft/catalog";

/**
 * Prose to subgraph.
 *
 * Two properties matter more than the model's fluency here:
 *
 *  1. It is grounded on the catalog, so it cannot invent a Cloudflare primitive
 *     that does not exist or misstate what one is for.
 *  2. Whatever comes back is validated against the same connection rules the
 *     canvas enforces. A proposal is a suggestion, not an authority — an edge
 *     the platform cannot express is dropped and reported, never drawn.
 *
 * The result is a *proposal*, deliberately: it lands on the canvas as something
 * to accept or reject, not as an edit that already happened.
 */

const ProposedNodeSchema = z.object({
  kind: z.string(),
  name: z.string(),
  why: z.string(),
});

const ProposedEdgeSchema = z.object({
  from: z.string(),
  to: z.string(),
  /** Empty string when the edge is a trigger, which carries no binding. */
  bindingName: z.string(),
});

const ProposalSchema = z.object({
  summary: z.string(),
  nodes: z.array(ProposedNodeSchema),
  edges: z.array(ProposedEdgeSchema),
  rejected: z.array(z.object({ kind: z.string(), because: z.string() })),
});

export type Proposal = z.infer<typeof ProposalSchema>;

export interface ProposalResult extends Proposal {
  /** Edges the model suggested that the platform cannot express. */
  dropped: { from: string; to: string; because: string }[];
}

export class NoCredentialsError extends Error {
  constructor(detail?: string) {
    super(
      [
        "No Anthropic credentials.",
        "The SDK looks for ANTHROPIC_API_KEY, then ANTHROPIC_AUTH_TOKEN, then an",
        '`ant auth login` profile — set any one of those, or add {"anthropic":',
        '{"apiKey":"..."}} to ~/.flarecraft/config.json.',
        detail ? `(${detail})` : "",
      ]
        .filter(Boolean)
        .join(" "),
    );
    this.name = "NoCredentialsError";
  }
}

/**
 * Whether any credential source the SDK consults exists.
 *
 * This duplicates a little of the SDK's resolution order, which is not ideal —
 * but the alternative is worse. When nothing is configured the SDK throws a
 * plain `Error`, not one of its typed classes, so there is nothing to catch on
 * except the message text. Checking the sources ourselves fails fast with an
 * actionable message and leaves the SDK as the authority whenever any source
 * does exist: this only ever decides whether to bother asking.
 *
 * Order mirrors the documented chain: explicit key, ANTHROPIC_API_KEY,
 * ANTHROPIC_AUTH_TOKEN, then an `ant auth login` profile on disk.
 */
function hasCredentialSource(explicitKey?: string): boolean {
  return Boolean(
    explicitKey ||
      process.env["ANTHROPIC_API_KEY"] ||
      process.env["ANTHROPIC_AUTH_TOKEN"] ||
      existsSync(join(homedir(), ".config", "anthropic")),
  );
}

/**
 * The catalog, rendered for the model.
 *
 * Built once at module load and kept byte-stable so it can sit behind a cache
 * breakpoint — it is the same several-thousand-token prefix on every request.
 */
const GROUNDING = buildGrounding();

function buildGrounding(): string {
  const primitives = Object.values(PRIMITIVES)
    .map((p) => {
      const choose = p.chooseWhen.map((c) => `      + ${c}`).join("\n");
      const avoid = p.avoidWhen.map((a) => `      - ${a}`).join("\n");
      return [
        `  ${p.kind} (${p.label}, ${p.category}) — ${p.summary}`,
        `    consistency: ${p.consistency}`,
        choose && `    choose when:\n${choose}`,
        avoid && `    avoid when:\n${avoid}`,
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n\n");

  const relations = RELATIONS.map(
    (r) => `  ${r.from} -> ${r.to}  (${r.kind})`,
  ).join("\n");

  return `## Cloudflare primitives\n\n${primitives}\n\n## Legal connections\n\nOnly these directed pairs exist. Anything else is impossible:\n\n${relations}`;
}

const SYSTEM = `You design Cloudflare Workers architectures.

Propose the smallest topology that does the job. Real systems are mostly a
Worker and one storage primitive; reach for more only when the requirements
genuinely demand it.

Rules:
- Use only the primitive kinds listed below. Never invent one.
- Every edge must be one of the listed legal connections, in that direction.
- Edge endpoints must be node names you declared in "nodes".
- Give each node a short lowercase name (a Durable Object class is PascalCase).
- Set bindingName to the SCREAMING_SNAKE variable the Worker code will use, or
  to an empty string for triggers, which have no binding.
- In "rejected", name the primitive a reader would reasonably have expected you
  to choose, and say what ruled it out. This is the most useful part of the
  answer — be specific about the constraint, not generic about the primitive.
- "why" on each node states what that node is doing in THIS system.`;

export interface ProposeOptions {
  /**
   * Supplied only when a key is configured explicitly. Left undefined, the SDK
   * resolves credentials itself: ANTHROPIC_API_KEY, then ANTHROPIC_AUTH_TOKEN,
   * then an `ant auth login` profile. An unset env var does not mean there are
   * no credentials, and forcing the key to be copied into flarecraft's own
   * config would break a perfectly good profile.
   */
  apiKey?: string;
  prompt: string;
  /** Names already on the canvas, so a proposal can extend rather than collide. */
  existingNodes?: { kind: string; name: string }[];
}

export async function proposeTopology(
  options: ProposeOptions,
): Promise<ProposalResult> {
  if (!hasCredentialSource(options.apiKey)) throw new NoCredentialsError();

  // No explicit key means the SDK resolves credentials itself — an unset
  // ANTHROPIC_API_KEY does not mean there are none, and forcing the key to be
  // copied into flarecraft's config would break a working `ant` profile.
  const client = options.apiKey
    ? new Anthropic({ apiKey: options.apiKey })
    : new Anthropic();

  const context = options.existingNodes?.length
    ? `\n\nThe canvas already contains these nodes; extend them rather than duplicating:\n${options.existingNodes
        .map((n) => `  ${n.kind} "${n.name}"`)
        .join("\n")}`
    : "";

  let response;
  try {
    response = await client.messages.parse({
      model: "claude-opus-5",
      max_tokens: 16000,
      thinking: { type: "adaptive" },
      output_config: {
        effort: "high",
        format: zodOutputFormat(ProposalSchema),
      },
      // The grounding block is identical on every request, so caching it keeps
      // repeated proposals cheap.
      system: [
        { type: "text", text: SYSTEM },
        { type: "text", text: GROUNDING, cache_control: { type: "ephemeral" } },
      ],
      messages: [{ role: "user", content: `${options.prompt}${context}` }],
    });
  } catch (error) {
    // Typed exception classes rather than string matching, most specific first.
    if (error instanceof Anthropic.AuthenticationError) {
      throw new NoCredentialsError();
    }
    if (error instanceof Anthropic.RateLimitError) {
      throw new Error("Rate limited by the Anthropic API. Try again shortly.");
    }
    if (error instanceof Anthropic.APIConnectionError) {
      throw new Error("Could not reach the Anthropic API. Check the network.");
    }
    if (error instanceof Anthropic.APIError) {
      throw new Error(`Anthropic API error ${error.status}: ${error.message}`);
    }
    throw error;
  }

  if (response.stop_reason === "refusal") {
    throw new Error("The model declined to answer that request.");
  }

  const proposal = response.parsed_output;
  if (!proposal) {
    throw new Error("The model did not return a usable topology proposal.");
  }

  return validate(proposal);
}

/**
 * Check the proposal against the catalog before it is allowed near the canvas.
 *
 * Unknown kinds and illegal edges are removed rather than trusted. The model is
 * good at this and still occasionally reaches for an edge that does not exist;
 * silently drawing one would undermine the guarantee that everything on the
 * canvas is deployable.
 */
export function validate(proposal: Proposal): ProposalResult {
  const nodes = proposal.nodes.filter((n) => Boolean(PRIMITIVES[n.kind]));
  const dropped: ProposalResult["dropped"] = [];

  for (const node of proposal.nodes) {
    if (!PRIMITIVES[node.kind]) {
      dropped.push({
        from: node.name,
        to: "—",
        because: `"${node.kind}" is not a Cloudflare primitive.`,
      });
    }
  }

  const kindOf = new Map(nodes.map((n) => [n.name, n.kind]));
  const edges = proposal.edges.filter((edge) => {
    const fromKind = kindOf.get(edge.from);
    const toKind = kindOf.get(edge.to);

    if (!fromKind || !toKind) {
      dropped.push({
        from: edge.from,
        to: edge.to,
        because: "One end of the edge is not a node in the proposal.",
      });
      return false;
    }
    if (!canConnect(fromKind, toKind)) {
      dropped.push({
        from: edge.from,
        to: edge.to,
        because: `A ${PRIMITIVES[fromKind]?.label} cannot connect to a ${PRIMITIVES[toKind]?.label} on Cloudflare.`,
      });
      return false;
    }
    return true;
  });

  return { ...proposal, nodes, edges, dropped };
}
