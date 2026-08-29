import { useMemo, useState } from "react";
import {
  DEFAULT_REQUIREMENTS,
  recommend,
  type Requirements,
} from "@flarecraft/catalog";
import { Button, Note, Select } from "./ui.js";
import { useStudio } from "./store.js";

/**
 * Help choosing what to place.
 *
 * Two paths onto the same canvas. The chooser is deterministic and runs in the
 * browser — no key, no network — and every recommendation carries the sentence
 * that justifies it. The prose path asks Claude, and its answer is validated
 * against the same connection rules before anything is drawn.
 */
export function Designer() {
  const [tab, setTab] = useState<"chooser" | "prose">("chooser");

  return (
    <div className="text-[11px]">
      <div className="mb-3 flex gap-2">
        <Button
          full
          tone={tab === "chooser" ? "primary" : "default"}
          onClick={() => setTab("chooser")}
        >
          Answer questions
        </Button>
        <Button
          full
          tone={tab === "prose" ? "primary" : "default"}
          onClick={() => setTab("prose")}
        >
          Describe it
        </Button>
      </div>
      {tab === "chooser" ? <Chooser /> : <Prose />}
    </div>
  );
}

const QUESTIONS: {
  key: keyof Requirements;
  label: string;
  options: { value: string; label: string }[];
}[] = [
  {
    key: "shape",
    label: "What starts the work?",
    options: [
      { value: "request", label: "An HTTP request" },
      { value: "event", label: "An event, handled out of band" },
      { value: "schedule", label: "A schedule" },
      { value: "long-running", label: "A multi-step process" },
    ],
  },
  {
    key: "duration",
    label: "How long does one unit of work take?",
    options: [
      { value: "sub-second", label: "Under a second" },
      { value: "seconds", label: "Seconds" },
      { value: "minutes", label: "Minutes" },
      { value: "hours", label: "Hours or more" },
    ],
  },
  {
    key: "cardinality",
    label: "How many distinct entities?",
    options: [
      { value: "single", label: "One global thing" },
      { value: "bounded", label: "A bounded set" },
      { value: "per-entity", label: "One per user or item" },
    ],
  },
  {
    key: "serialization",
    label: "Must writes to one entity be serialized?",
    options: [
      { value: "not-required", label: "No" },
      { value: "required", label: "Yes — concurrent writers would race" },
      { value: "no-writes", label: "Nothing is written" },
    ],
  },
  {
    key: "consistency",
    label: "Must a read see its own write?",
    options: [
      { value: "eventual-ok", label: "No, staleness is fine" },
      { value: "read-after-write", label: "Yes, immediately" },
    ],
  },
  {
    key: "access",
    label: "How is data accessed?",
    options: [
      { value: "none", label: "Nothing is stored" },
      { value: "key-lookup", label: "Fetch by key" },
      { value: "relational", label: "Relational queries and joins" },
      { value: "blob", label: "Files and large objects" },
      { value: "vector", label: "Similarity search" },
      { value: "append-only", label: "High-volume append-only events" },
    ],
  },
  {
    key: "runtime",
    label: "What does the code need to run?",
    options: [
      { value: "javascript", label: "JavaScript or WASM" },
      { value: "native", label: "A native binary or full filesystem" },
    ],
  },
  {
    key: "existingDatabase",
    label: "Is there already a SQL database?",
    options: [
      { value: "none", label: "No" },
      { value: "postgres-or-mysql", label: "Yes, Postgres or MySQL" },
    ],
  },
];

function Chooser() {
  const [requirements, setRequirements] = useState<Requirements>(DEFAULT_REQUIREMENTS);
  const applyTopology = useStudio((s) => s.applyTopology);
  const system = useStudio((s) => s.system);

  const result = useMemo(() => recommend(requirements), [requirements]);

  return (
    <div>
      {QUESTIONS.map((question) => (
        <label key={question.key} className="mb-2 block">
          <span className="mb-1 block text-ink-dim">{question.label}</span>
          <Select
            value={requirements[question.key]}
            onChange={(e) =>
              setRequirements((r) => ({ ...r, [question.key]: e.target.value }))
            }
          >
            {question.options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        </label>
      ))}

      <div className="mt-4">
        {result.decisions.map((decision) => (
          <section key={decision.role} className="mb-4">
            <h3 className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-ink-faint">
              {decision.role}
            </h3>

            {decision.chosen ? (
              <>
                <p className="font-semibold text-accent">{decision.chosen.label}</p>
                <ul className="mt-1">
                  {decision.chosen.reasons.map((reason) => (
                    <li key={reason} className="mb-1 leading-relaxed text-ink-dim">
                      {reason}
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <p className="text-ink-dim">Nothing needed.</p>
            )}

            {/* The rejected alternative is the useful half: it is the choice you
                would otherwise spend a week discovering was wrong. */}
            {decision.rejected
              .filter((c) => c.disqualifiedBecause)
              .slice(0, 3)
              .map((candidate) => (
                <p key={candidate.kind} className="mt-2 leading-relaxed text-ink-faint">
                  <span className="text-warn">not {candidate.label}</span> —{" "}
                  {candidate.disqualifiedBecause}
                </p>
              ))}
          </section>
        ))}

        {result.warnings.map((warning) => (
          <Note key={warning} tone="warn">
            {warning}
          </Note>
        ))}

        <Button full tone="primary" onClick={() => applyTopology(result.topology)} disabled={!system}>
          Add {result.topology.nodes.length} element(s) to the canvas
        </Button>
      </div>
    </div>
  );
}

interface ProposalResponse {
  summary: string;
  nodes: { kind: string; name: string; why: string }[];
  edges: { from: string; to: string; bindingName: string }[];
  rejected: { kind: string; because: string }[];
  dropped: { from: string; to: string; because: string }[];
  error?: string;
  detail?: string;
}

function Prose() {
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [proposal, setProposal] = useState<ProposalResponse | undefined>();

  const system = useStudio((s) => s.system);
  const applyTopology = useStudio((s) => s.applyTopology);

  const propose = async () => {
    setBusy(true);
    setError(undefined);
    setProposal(undefined);
    try {
      const response = await fetch("/api/design/propose", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt,
          existingNodes: (system?.nodes ?? []).map((n) => ({
            kind: n.kind,
            name: n.name,
          })),
        }),
      });
      const body = (await response.json()) as ProposalResponse;
      if (!response.ok || body.error) {
        setError([body.error, body.detail].filter(Boolean).join(" "));
        return;
      }
      setProposal(body);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        rows={4}
        spellCheck={false}
        placeholder="A webhook receiver that verifies signatures, queues each event, and writes results somewhere I can query by customer…"
        className="w-full rounded border border-line bg-surface px-2 py-1.5 text-[11px] text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none"
      />
      <div className="mt-2">
        <Button full tone="primary" onClick={() => void propose()} disabled={busy || !prompt.trim()}>
          {busy ? "thinking…" : "Propose a topology"}
        </Button>
      </div>

      {error && (
        <div className="mt-3">
          <Note tone="error">{error}</Note>
        </div>
      )}

      {proposal && (
        <div className="mt-4">
          <p className="mb-3 leading-relaxed">{proposal.summary}</p>

          {proposal.nodes.map((node) => (
            <p key={node.name} className="mb-2 leading-relaxed">
              <span className="text-accent">{node.name}</span>{" "}
              <span className="text-ink-faint">({node.kind})</span> — {node.why}
            </p>
          ))}

          {proposal.rejected.map((r) => (
            <p key={r.kind} className="mb-2 leading-relaxed text-ink-faint">
              <span className="text-warn">not {r.kind}</span> — {r.because}
            </p>
          ))}

          {/* Anything the validator threw out is shown, not hidden. A proposal
              that suggested an impossible edge is worth knowing about. */}
          {proposal.dropped.length > 0 && (
            <div className="mb-2 rounded border border-danger/50 px-2 py-2">
              <p className="mb-1 text-danger">Dropped as impossible:</p>
              {proposal.dropped.map((d, i) => (
                <p key={i} className="leading-relaxed text-ink-faint">
                  {d.from} → {d.to}: {d.because}
                </p>
              ))}
            </div>
          )}

          <Button
            full
            tone="primary"
            disabled={!system}
            onClick={() =>
              applyTopology({
                nodes: proposal.nodes,
                edges: proposal.edges.map((e) => ({
                  from: e.from,
                  to: e.to,
                  ...(e.bindingName ? { bindingName: e.bindingName } : {}),
                })),
              })
            }
          >
            Accept — add to canvas
          </Button>
        </div>
      )}
    </div>
  );
}
