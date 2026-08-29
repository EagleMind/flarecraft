import ELK from "elkjs/lib/elk.bundled.js";
import { Position } from "@xyflow/react";
import type { SystemModel } from "@flarecraft/model";

const elk = new ELK();

export const NODE_WIDTH = 210;
export const NODE_HEIGHT = 62;

/**
 * The node's handles, declared rather than measured.
 *
 * React Flow normally discovers handle positions with a ResizeObserver pass,
 * and `getEdgePosition` refuses to route an edge until it has them. But every
 * primitive node is a fixed 210x62 with a target on the left edge and a source
 * on the right, both vertically centred — PrimitiveNode hard-codes exactly
 * that. `Node.handles` is React Flow's first-class way to state geometry you
 * already know, and `isNodeInitialized` accepts it in place of a measurement.
 *
 * Coordinates follow `getHandlePosition`: x and y are offsets from the node
 * origin, and a Left handle resolves to (x, y + height/2) while a Right handle
 * resolves to (x + width, y + height/2). With 1x1 handles that puts the two
 * connection points exactly on the left and right edges at mid-height.
 *
 * If a real measurement does land, `internals.handleBounds` takes precedence —
 * this is the floor, not a substitute.
 */
export const NODE_HANDLES = [
  {
    id: null,
    type: "target" as const,
    position: Position.Left,
    x: 0,
    y: NODE_HEIGHT / 2 - 0.5,
    width: 1,
    height: 1,
  },
  {
    id: null,
    type: "source" as const,
    position: Position.Right,
    x: NODE_WIDTH - 1,
    y: NODE_HEIGHT / 2 - 0.5,
    width: 1,
    height: 1,
  },
];

/**
 * Auto-layout for a scanned topology.
 *
 * Layered left-to-right, because a Cloudflare system reads as a flow: ingress
 * on the left, Workers in the middle, storage on the right. Hand-placing forty
 * nodes is not an option after a scan, but once the user moves a node their
 * position is kept and a re-layout is something they ask for explicitly.
 */
export async function layoutSystem(
  system: SystemModel,
): Promise<Map<string, { x: number; y: number }>> {
  const graph = {
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "RIGHT",
      "elk.layered.spacing.nodeNodeBetweenLayers": "110",
      "elk.spacing.nodeNode": "38",
      "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
      // Keeps edge labels (binding names) from colliding with the nodes.
      "elk.spacing.edgeNode": "24",
      "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
    },
    children: system.nodes.map((node) => ({
      id: node.id,
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
    })),
    // ELK rejects edges pointing at nodes it does not know about, and a scan
    // can legitimately produce one — a service binding naming a Worker that no
    // longer exists is exactly the kind of thing worth surfacing, not crashing on.
    edges: system.edges
      .filter((edge) => {
        const ids = new Set(system.nodes.map((n) => n.id));
        return ids.has(edge.from) && ids.has(edge.to);
      })
      .map((edge) => ({
        id: edge.id,
        sources: [edge.from],
        targets: [edge.to],
      })),
  };

  const result = await elk.layout(graph);
  const positions = new Map<string, { x: number; y: number }>();
  for (const child of result.children ?? []) {
    positions.set(child.id, { x: child.x ?? 0, y: child.y ?? 0 });
  }
  return positions;
}
