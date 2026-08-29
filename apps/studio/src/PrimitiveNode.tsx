import { Handle, Position, type NodeProps, type Node as FlowNode } from "@xyflow/react";
import { PRIMITIVES, type PrimitiveCategory } from "@flarecraft/catalog";
import type { Node } from "@flarecraft/model";

export type PrimitiveFlowNode = FlowNode<
  {
    node: Node;
    severity?: "error" | "warning" | "info";
    /** Live traffic for this Worker, when an activity refresh has run. */
    activity?: { requests: number; errors: number };
  },
  "primitive"
>;

/**
 * Tailwind cannot see a class assembled at runtime, so category styling is a
 * lookup rather than an interpolation.
 */
const STRIPE: Record<PrimitiveCategory, string> = {
  compute: "bg-compute",
  storage: "bg-storage",
  messaging: "bg-messaging",
  ingress: "bg-ingress",
  service: "bg-service",
  external: "bg-external",
};

const RING: Record<PrimitiveCategory, string> = {
  compute: "border-compute",
  storage: "border-storage",
  messaging: "border-messaging",
  ingress: "border-ingress",
  service: "border-service",
  external: "border-external",
};

const DOT: Record<string, string> = {
  error: "bg-danger",
  warning: "bg-warn",
  info: "bg-ink-faint",
};

export function PrimitiveNode({ data, selected }: NodeProps<PrimitiveFlowNode>) {
  const node = data.node;
  const spec = PRIMITIVES[node.kind];
  const category = spec?.category ?? "external";

  return (
    <div
      className={`flex h-[62px] w-[210px] items-center gap-3 rounded-lg border bg-raised px-3 py-2 shadow-lg transition-colors ${
        selected ? RING[category] : "border-line"
      }`}
    >
      <Handle type="target" position={Position.Left} className="!bg-ink-faint" />

      {/* The category stripe carries the type, so the graph stays readable when
          zoomed out past the point where any label can be read. */}
      <span className={`h-9 w-1 shrink-0 rounded-full ${STRIPE[category]}`} aria-hidden />

      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-medium text-ink" title={node.name}>
          {node.name}
        </span>
        <span className="block truncate text-[11px] text-ink-dim">
          {spec?.label ?? node.kind}
          {/* A name we had to invent is marked, so nobody mistakes a binding
              variable for the resource's real title. */}
          {node.nameIsFallback ? " · name unresolved" : ""}
        </span>
      </span>

      {/* Live traffic sits on the element rather than in a separate dashboard —
          the whole reason to have the map is that everything about a piece is
          in one place. */}
      {data.activity && (
        <span className="shrink-0 text-right leading-tight">
          <span className="block text-[10px] text-ink">
            {formatCount(data.activity.requests)}
          </span>
          <span
            className={`block text-[9px] ${
              data.activity.errors > 0 ? "text-danger" : "text-ink-faint"
            }`}
          >
            {data.activity.errors > 0 ? `${formatCount(data.activity.errors)} err` : "24h"}
          </span>
        </span>
      )}

      {/* The dot is why linting continuously is worth anything: the problem is
          on the node you are looking at, not in a report you have to go open. */}
      {data.severity && (
        <span
          className={`size-2 shrink-0 rounded-full ${DOT[data.severity]}`}
          title={`${data.severity} — see Review`}
        />
      )}

      <Handle type="source" position={Position.Right} className="!bg-ink-faint" />
    </div>
  );
}

/** Compact enough to sit on a node without widening it. */
function formatCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}
