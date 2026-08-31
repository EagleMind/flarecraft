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
 *
 * Runs through OpenRouter rather than talking to a single model provider
 * directly, so the key, the model, and the failure modes are all one
 * OpenAI-compatible surface instead of a provider-specific SDK.
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

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_MODEL = "openai/gpt-4o";

export class NoCredentialsError extends Error {
  constructor(detail?: string) {
    super(
      [
        "No OpenRouter credentials.",
        'Set OPENROUTER_API_KEY, or add {"openrouter": {"apiKey":',
        '"..."}} to ~/.flarecraft/config.json.',
        detail ? `(${detail})` : "",
      ]
        .filter(Boolean)
        .join(" "),
    );
    this.name = "NoCredentialsError";
  }
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
- "why" on each node states what that node is doing in THIS system.
- Respond with JSON only, matching the given schema exactly.`;

const PROPOSAL_JSON_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    nodes: {
      type: "array",
      items: {
        type: "object",
        properties: {
          kind: { type: "string" },
          name: { type: "string" },
          why: { type: "string" },
        },
        required: ["kind", "name", "why"],
        additionalProperties: false,
      },
    },
    edges: {
      type: "array",
      items: {
        type: "object",
        properties: {
          from: { type: "string" },
          to: { type: "string" },
          bindingName: { type: "string" },
        },
        required: ["from", "to", "bindingName"],
        additionalProperties: false,
      },
    },
    rejected: {
      type: "array",
      items: {
        type: "object",
        properties: {
          kind: { type: "string" },
          because: { type: "string" },
        },
        required: ["kind", "because"],
        additionalProperties: false,
      },
    },
  },
  required: ["summary", "nodes", "edges", "rejected"],
  additionalProperties: false,
} as const;

export interface ProposeOptions {
  /**
   * Supplied only when a key is configured explicitly. Left undefined, this
   * falls back to OPENROUTER_API_KEY. An unset env var does not mean there is
   * no key configured elsewhere.
   */
  apiKey?: string;
  /** Overrides the default model, e.g. via OPENROUTER_MODEL. */
  model?: string;
  prompt: string;
  /** Names already on the canvas, so a proposal can extend rather than collide. */
  existingNodes?: { kind: string; name: string }[];
}

function hasCredentialSource(explicitKey?: string): boolean {
  return Boolean(explicitKey || process.env["OPENROUTER_API_KEY"]);
}

interface OpenRouterResponse {
  choices?: { message?: { content?: string; refusal?: string } }[];
  error?: { message?: string };
}

export async function proposeTopology(
  options: ProposeOptions,
): Promise<ProposalResult> {
  const apiKey = options.apiKey || process.env["OPENROUTER_API_KEY"];
  if (!hasCredentialSource(apiKey)) throw new NoCredentialsError();

  const context = options.existingNodes?.length
    ? `\n\nThe canvas already contains these nodes; extend them rather than duplicating:\n${options.existingNodes
        .map((n) => `  ${n.kind} "${n.name}"`)
        .join("\n")}`
    : "";

  let httpResponse: Response;
  try {
    httpResponse = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://github.com/flarecraft",
        "X-Title": "flarecraft",
      },
      body: JSON.stringify({
        model: options.model || process.env["OPENROUTER_MODEL"] || DEFAULT_MODEL,
        messages: [
          { role: "system", content: `${SYSTEM}\n\n${GROUNDING}` },
          { role: "user", content: `${options.prompt}${context}` },
        ],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "proposal",
            strict: true,
            schema: PROPOSAL_JSON_SCHEMA,
          },
        },
      }),
    });
  } catch {
    throw new Error("Could not reach the OpenRouter API. Check the network.");
  }

  if (httpResponse.status === 401 || httpResponse.status === 403) {
    throw new NoCredentialsError();
  }
  if (httpResponse.status === 429) {
    throw new Error("Rate limited by the OpenRouter API. Try again shortly.");
  }

  const body = (await httpResponse.json()) as OpenRouterResponse;

  if (!httpResponse.ok) {
    throw new Error(
      `OpenRouter API error ${httpResponse.status}: ${body.error?.message ?? httpResponse.statusText}`,
    );
  }

  const message = body.choices?.[0]?.message;
  if (message?.refusal) {
    throw new Error("The model declined to answer that request.");
  }

  const content = message?.content;
  if (!content) {
    throw new Error("The model did not return a usable topology proposal.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error("The model's response was not valid JSON.");
  }

  const result = ProposalSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error("The model did not return a usable topology proposal.");
  }

  return validate(result.data);
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
