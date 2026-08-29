import { lint, type Finding, type Severity } from "@flarecraft/rules";
import type { SystemModel } from "@flarecraft/model";
import { Badge, Muted } from "./ui.js";
import { useStudio } from "./store.js";

/**
 * Lint results for the current system.
 *
 * Findings are clickable and select the offending element, so the panel and the
 * canvas stay in step — a list of problems you cannot locate is a report, and
 * the point of running these continuously is that they are not a report.
 */
export function Findings({ system }: { system: SystemModel }) {
  const select = useStudio((s) => s.select);
  const findings = lint(system);

  if (findings.length === 0) {
    return <Muted>Nothing to report. This topology looks sound.</Muted>;
  }

  const counts = findings.reduce<Record<string, number>>((acc, f) => {
    acc[f.severity] = (acc[f.severity] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <section className="text-[11px]">
      <p className="mb-3 text-[10px] uppercase tracking-wider text-ink-faint">
        {(["error", "warning", "info"] as const)
          .filter((s) => counts[s])
          .map((s) => `${counts[s]} ${s}`)
          .join(" · ")}
      </p>

      <ul>
        {findings.map((finding, index) => (
          <Row
            key={`${finding.rule}-${index}`}
            finding={finding}
            onSelect={() => finding.nodeId && select(finding.nodeId)}
          />
        ))}
      </ul>
    </section>
  );
}

function Row({ finding, onSelect }: { finding: Finding; onSelect: () => void }) {
  return (
    <li
      onClick={onSelect}
      role={finding.nodeId ? "button" : undefined}
      className={`mb-3 rounded border border-transparent px-2 py-2 leading-relaxed transition-colors ${
        finding.nodeId ? "cursor-pointer hover:border-line hover:bg-raised" : ""
      }`}
    >
      <span className="mr-1.5 align-middle">
        <Badge tone={finding.severity}>{finding.severity}</Badge>
      </span>
      {finding.message}
      {finding.remedy && (
        <span className="mt-1 block text-ink-faint">{finding.remedy}</span>
      )}
      {finding.docs && (
        <a
          href={finding.docs}
          target="_blank"
          rel="noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="mt-1 inline-block text-[10px] text-accent underline"
        >
          docs
        </a>
      )}
    </li>
  );
}

/** Worst severity per node, for the dot the canvas draws on each one. */
export function severityByNode(system: SystemModel): Map<string, Severity> {
  const rank: Record<Severity, number> = { error: 0, warning: 1, info: 2 };
  const worst = new Map<string, Severity>();

  for (const finding of lint(system)) {
    if (!finding.nodeId) continue;
    const current = worst.get(finding.nodeId);
    if (!current || rank[finding.severity] < rank[current]) {
      worst.set(finding.nodeId, finding.severity);
    }
  }
  return worst;
}

/**
 * Counts by severity, for the Review tab's badge.
 *
 * Showing the count on the tab means you can tell there is something wrong
 * without switching to look — the difference between a panel you check and one
 * you remember to check.
 */
export function findingCounts(system: SystemModel): {
  error: number;
  warning: number;
  info: number;
  total: number;
} {
  const counts = { error: 0, warning: 0, info: 0, total: 0 };
  for (const finding of lint(system)) {
    counts[finding.severity] += 1;
    counts.total += 1;
  }
  return counts;
}
