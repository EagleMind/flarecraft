import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  applyNodeChanges,
  Background,
  Controls,
  MiniMap,
  Panel,
  ReactFlow,
  useStore,
  useReactFlow,
  type Connection,
  type Edge as FlowEdge,
  type NodeChange,
} from "@xyflow/react";
import { canConnect, PRIMITIVES } from "@flarecraft/catalog";
import type { NodeKind } from "@flarecraft/model";
import { PrimitiveNode, type PrimitiveFlowNode } from "./PrimitiveNode.js";
import { NODE_HANDLES, NODE_HEIGHT, NODE_WIDTH } from "./layout.js";
import { DRAG_MIME } from "./Palette.js";
import { useStudio } from "./store.js";
import { Groups } from "./Groups.js";
import { SelectionBar } from "./SelectionBar.js";
import { OrganizeDialog } from "./OrganizeDialog.js";
import { severityByNode } from "./Findings.js";

const nodeTypes = { primitive: PrimitiveNode };

const MINIMAP_COLOR: Record<string, string> = {
  compute: "#e08a4a",
  storage: "#4a9ae0",
  messaging: "#4ae08a",
  ingress: "#b47ae0",
  service: "#e0c14a",
  external: "#6b7280",
};

export function Canvas() {
  const system = useStudio((s) => s.system);
  const selectedNodeId = useStudio((s) => s.selectedNodeId);
  const select = useStudio((s) => s.select);
  const moveNode = useStudio((s) => s.moveNode);
  const place = useStudio((s) => s.place);
  const link = useStudio((s) => s.link);
  const unlink = useStudio((s) => s.unlink);
  const drop = useStudio((s) => s.drop);
  const activity = useStudio((s) => s.activity);
  const undo = useStudio((s) => s.undo);
  const redo = useStudio((s) => s.redo);
  const relayout = useStudio((s) => s.relayout);
  const past = useStudio((s) => s.past);
  const future = useStudio((s) => s.future);

  const { screenToFlowPosition } = useReactFlow();
  const organize = useStudio((s) => s.organize);

  // Which group, if any, is being consolidated right now.
  const [organizing, setOrganizing] = useState<string | undefined>();
  /**
   * Which nodes are selected right now, read straight off React Flow's store.
   *
   * `useOnSelectionChange` is the documented hook for this and it does not work
   * here: it fires once on mount and then never again, even while the store's
   * own `nodeLookup` correctly marks nodes selected. Subscribing to the store
   * has no such gap — and no handler registration to get the timing of wrong.
   * Serializing keeps the selector's result a primitive, so it only re-renders
   * when the selection genuinely changes. Cron node ids contain spaces, so
   * this is JSON rather than a joined delimiter.
   */
  const selectionKey = useStore((state) => {
    const ids: string[] = [];
    for (const [, node] of state.nodeLookup) if (node.selected) ids.push(node.id);
    return JSON.stringify(ids);
  });
  const selected = useMemo(
    () => JSON.parse(selectionKey) as string[],
    [selectionKey],
  );

  /**
   * React Flow owns the node array, not the store.
   *
   * v12 reports measured node dimensions through `onNodesChange`, and those
   * measurements are what edge routing needs to locate handles. Rebuilding the
   * array from the model on every render throws them away, and the symptom is
   * that every edge silently fails to render while the nodes look fine.
   */
  const [flowNodes, setFlowNodes] = useState<PrimitiveFlowNode[]>([]);

  // Rebuild only when graph membership changes — not on a position update, or
  // dragging a node would reset its own measurement mid-drag.
  const membership = useMemo(
    () => (system?.nodes ?? []).map((n) => n.id).join("|"),
    [system],
  );

  useEffect(() => {
    setFlowNodes(
      (system?.nodes ?? []).map((node) => ({
        id: node.id,
        type: "primitive" as const,
        position: node.position ?? { x: 0, y: 0 },
        data: { node },
        // Nodes are a fixed size by construction — PrimitiveNode hard-codes it
        // — so React Flow is told the dimensions rather than made to discover
        // them. Declaring what we already know is both more correct and one
        // fewer thing that has to happen before the first paint.
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
        measured: { width: NODE_WIDTH, height: NODE_HEIGHT },
        handles: NODE_HANDLES,
      })),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [membership]);

  // Lint results ride along on each node so the canvas can mark the problem
  // where it is, rather than only listing it in the side panel.
  const severities = useMemo(
    () => (system ? severityByNode(system) : new Map<string, "error" | "warning" | "info">()),
    [system],
  );

  // Keep the model's data on each node current without touching identity or
  // measurement, so a rename shows on the canvas immediately.
  const lastFocused = useRef<string | undefined>(undefined);
  useEffect(() => {
    // This effect also re-runs on an activity poll or any model edit. Only a
    // genuine change of focus may rewrite selection — otherwise a marquee
    // selection would silently collapse the next time traffic came in.
    const focusChanged = lastFocused.current !== selectedNodeId;
    lastFocused.current = selectedNodeId;
    setFlowNodes((current) =>
      current.map((flowNode) => {
        const model = system?.nodes.find((n) => n.id === flowNode.id);
        if (!model) return flowNode;
        const severity = severities.get(model.id);
        const traffic = model.kind === "worker" ? activity[model.name] : undefined;
        return {
          ...flowNode,
          data: {
            node: model,
            ...(severity ? { severity } : {}),
            ...(traffic ? { activity: traffic } : {}),
          },
          selected: focusChanged
            ? model.id === selectedNodeId
            : (flowNode.selected ?? false),
        };
      }),
    );
  }, [system, selectedNodeId, severities, activity]);

  const flowEdges: FlowEdge[] = useMemo(() => {
    const ids = new Set((system?.nodes ?? []).map((n) => n.id));
    return (system?.edges ?? [])
      .filter((edge) => ids.has(edge.from) && ids.has(edge.to))
      .map((edge) => ({
        id: edge.id,
        source: edge.from,
        target: edge.to,
        // The binding variable is the most useful label on the canvas: it is
        // what the code says, and what the dashboard hides behind a settings page.
        label: edge.bindingName ? `env.${edge.bindingName}` : edge.kind,
        animated: edge.kind === "queue_consumer",
        style: {
          stroke: edge.kind === "trigger" ? "var(--color-ingress)" : "var(--color-line)",
          strokeDasharray: edge.kind === "tail" ? "4 3" : undefined,
        },
        labelStyle: { fill: "var(--color-ink-dim)", fontSize: 10 },
        labelBgStyle: { fill: "var(--color-surface)" },
      }));
  }, [system]);

  // Undo/redo belong on the keyboard; direct manipulation is unusable without.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (!(event.ctrlKey || event.metaKey)) return;
      if (event.key === "z" && !event.shiftKey) {
        event.preventDefault();
        undo();
      } else if (event.key === "y" || (event.key === "z" && event.shiftKey)) {
        event.preventDefault();
        redo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, redo]);

  const onNodesChange = useCallback((changes: NodeChange<PrimitiveFlowNode>[]) => {
    setFlowNodes((current) => applyNodeChanges(changes, current));
  }, []);

  /**
   * The catalog decides what may connect to what, so an illegal edge cannot be
   * drawn at all — the connection line simply refuses to land. This is the
   * difference between a drawing tool and a design tool.
   */
  const isValidConnection = useCallback(
    (connection: Connection | FlowEdge) => {
      const from = system?.nodes.find((n) => n.id === connection.source);
      const to = system?.nodes.find((n) => n.id === connection.target);
      if (!from || !to || from.id === to.id) return false;
      return canConnect(from.kind, to.kind);
    },
    [system],
  );

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      const kind = event.dataTransfer.getData(DRAG_MIME) as NodeKind;
      if (!kind || !PRIMITIVES[kind]) return;
      place(
        kind,
        screenToFlowPosition({ x: event.clientX, y: event.clientY }),
      );
    },
    [place, screenToFlowPosition],
  );

  return (
    <Fragment>
      <ReactFlow
        nodes={flowNodes}
        edges={flowEdges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onNodeDragStop={(_, node) => moveNode(node.id, node.position)}
        onNodeClick={(event, node) => {
          // Shift-click extends the selection. Focusing the clicked node would
          // rewrite `selected` above and undo the extension.
          if (!event.shiftKey) select(node.id);
        }}
        onPaneClick={() => select(undefined)}
        onConnect={(connection) => {
          if (connection.source && connection.target)
            link(connection.source, connection.target);
        }}
        isValidConnection={isValidConnection}
        onEdgesDelete={(edges) => edges.forEach((edge) => unlink(edge.id))}
        onNodesDelete={(nodes) => nodes.forEach((node) => drop(node.id))}
        onDrop={onDrop}
        onDragOver={(event) => {
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
        }}
        fitView
        minZoom={0.1}
        deleteKeyCode={["Backspace", "Delete"]}
        // Shift+drag marquees and Shift+click extends. `panOnDrag` is left alone,
        // so plain left-drag still pans exactly as it did before.
        selectionKeyCode="Shift"
        multiSelectionKeyCode="Shift"
      >
        {/* Canvas actions live on the canvas. Keeping undo, redo, and layout in
          the side panel put manipulation controls next to data controls, which
          made both harder to find. */}
        <Panel position="top-left" className="flex gap-1">
          <CanvasButton
            onClick={undo}
            disabled={past.length === 0}
            title="Undo (Ctrl+Z)"
          >
            ↶{past.length > 0 ? ` ${past.length}` : ""}
          </CanvasButton>
          <CanvasButton
            onClick={redo}
            disabled={future.length === 0}
            title="Redo (Ctrl+Shift+Z)"
          >
            ↷
          </CanvasButton>
          <CanvasButton
            onClick={() => void relayout()}
            title="Re-arrange everything"
          >
            Tidy up
          </CanvasButton>
          <CanvasButton
            onClick={organize}
            title="Find the systems hiding in this account and draw them"
          >
            Organize
          </CanvasButton>
        </Panel>

        {system && <Groups system={system} onSave={setOrganizing} />}
        {system && <SelectionBar system={system} selected={selected} />}

        <Background color="var(--color-line)" gap={22} size={1} />
        <Controls showInteractive={false} />
        <MiniMap
          pannable
          zoomable
          className="!bg-sunken"
          maskColor="rgba(0,0,0,0.6)"
          nodeColor={(n) =>
            MINIMAP_COLOR[
              PRIMITIVES[(n as PrimitiveFlowNode).data.node.kind]?.category ??
                "external"
            ] ?? "#6b7280"
          }
        />
      </ReactFlow>

      {organizing && system && (
        <OrganizeDialog
          system={system}
          groupId={organizing}
          onClose={() => setOrganizing(undefined)}
        />
      )}
    </Fragment>
  );
}

function CanvasButton({
  onClick,
  disabled,
  title,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="rounded border border-line bg-raised px-2 py-1 text-[11px] text-ink transition-colors hover:border-line-strong disabled:cursor-not-allowed disabled:opacity-30"
    >
      {children}
    </button>
  );
}
