import { create } from "zustand";
import {
  addNode,
  applyProposal,
  connect,
  emptySystem,
  patchConsumer,
  patchEdgeConfig,
  patchNodeConfig,
  patchWorker,
  removeEdge,
  removeNode,
  renameBinding,
  renameNode,
  type Node,
  type NodeKind,
  type ProposedTopology,
  type SystemModel,
} from "@flarecraft/model";
import { layoutSystem } from "./layout.js";

export type SourceKind = "repo" | "account" | "design";

export interface Warning {
  code: string;
  message: string;
  detail?: string;
  configPath?: string;
}

interface SystemResponse {
  system: SystemModel;
  warnings?: Warning[];
  configPaths?: string[];
  covered?: string[];
  error?: string;
  detail?: string;
}

/** How many edits back you can go. Snapshots are small; this is generous. */
const HISTORY_LIMIT = 100;

interface StudioState {
  system: SystemModel | undefined;
  past: SystemModel[];
  future: SystemModel[];

  warnings: Warning[];
  source: SourceKind | undefined;
  covered: string[];
  configPaths: string[];
  loading: boolean;
  error: string | undefined;
  /** Transient message for a refused connection, shown then dismissed. */
  notice: string | undefined;
  selectedNodeId: string | undefined;
  /** Config-versus-deployed findings, empty until a drift check is run. */
  drift: Warning[];

  loadRepo: (root: string) => Promise<void>;
  loadAccount: () => Promise<void>;
  newSystem: (name: string, folder?: string) => void;
  /** Folder this system is written to, when it has one. */
  projectFolder: string | undefined;
  scaffold: (folder?: string) => Promise<void>;
  /**
   * True once the canvas has been edited since the last write. Auto-sync waits
   * for this, so merely opening a project never rewrites its files.
   */
  dirty: boolean;
  openProject: (folder: string) => Promise<void>;

  select: (nodeId: string | undefined) => void;
  setNotice: (notice: string | undefined) => void;

  place: (kind: NodeKind, position: { x: number; y: number }) => void;
  applyTopology: (proposal: ProposedTopology) => void;
  link: (fromId: string, toId: string) => void;
  unlink: (edgeId: string) => void;
  drop: (nodeId: string) => void;
  moveNode: (nodeId: string, position: { x: number; y: number }) => void;
  rename: (nodeId: string, name: string) => void;
  editWorker: (nodeId: string, patch: Partial<NonNullable<Node["worker"]>>) => void;
  editBinding: (edgeId: string, bindingName: string) => void;
  setNodeConfig: (nodeId: string, patch: Record<string, unknown>) => void;
  setEdgeConfig: (edgeId: string, patch: Record<string, unknown>) => void;
  setConsumer: (edgeId: string, patch: Record<string, unknown>) => void;

  undo: () => void;
  redo: () => void;
  relayout: () => Promise<void>;

  exportRepo: (outDir: string) => Promise<void>;
  checkDrift: (root: string) => Promise<void>;
  reset: () => void;
  /** Live traffic per Worker name, empty until a refresh is asked for. */
  activity: Record<string, { requests: number; errors: number }>;
  activityWarnings: string[];
  refreshActivity: () => Promise<void>;
}

export const useStudio = create<StudioState>((set, get) => {
  /**
   * Every graph edit goes through here.
   *
   * Snapshotting whole systems rather than diffing operations is the right
   * trade at this size — a large topology is a few hundred small objects — and
   * it makes undo exact by construction instead of depending on every mutation
   * having a correct inverse.
   */
  const commit = (next: SystemModel): void => {
    const current = get().system;
    if (!current) {
      set({ system: next });
      return;
    }
    set({
      system: next,
      past: [...get().past, current].slice(-HISTORY_LIMIT),
      future: [],
      dirty: true,
    });
  };

  const edit = (fn: (system: SystemModel) => SystemModel): void => {
    const system = get().system;
    if (!system) return;
    commit(fn(system));
  };

  return {
    system: undefined,
    past: [],
    future: [],
    warnings: [],
    source: undefined,
    covered: [],
    configPaths: [],
    loading: false,
    error: undefined,
    notice: undefined,
    selectedNodeId: undefined,
    drift: [],
    activity: {},
    projectFolder: undefined,
    dirty: false,
    activityWarnings: [],

    loadRepo: async (root) => {
      await load(set, `/api/system/repo?root=${encodeURIComponent(root)}`, "repo");
    },

    loadAccount: async () => {
      await load(set, "/api/system/account", "account");
    },

    newSystem: (name, folder) => {
      set({
        projectFolder: folder?.trim() || undefined,
        system: emptySystem(`design:${Date.now().toString(36)}`, name),
        past: [],
        future: [],
        warnings: [],
        configPaths: [],
        covered: [],
        source: "design",
        selectedNodeId: undefined,
        error: undefined,
      });
    },

    select: (selectedNodeId) => set({ selectedNodeId }),
    setNotice: (notice) => set({ notice }),

    place: (kind, position) => {
      const system = get().system;
      if (!system) return;
      const { system: next, node } = addNode(system, kind, position);
      commit(next);
      set({ selectedNodeId: node.id });
    },

    /**
     * Land a proposal on the canvas as one undoable step, so a recommendation
     * you dislike is a single Ctrl+Z rather than a cleanup job.
     */
    applyTopology: (proposal) => {
      const system = get().system;
      if (!system) return;
      const result = applyProposal(system, proposal, { x: 40, y: 40 });
      commit(result.system);
      set({
        notice: result.rejected.length
          ? `Applied ${result.added.length} node(s). Skipped: ${result.rejected.join(" ")}`
          : `Applied ${result.added.length} node(s).`,
      });
    },

    link: (fromId, toId) => {
      const system = get().system;
      if (!system) return;
      const result = connect(system, fromId, toId);
      if (result.rejected) {
        // The refusal is shown rather than swallowed: the user needs to know
        // *why* the platform will not express what they just drew.
        set({ notice: result.rejected });
        return;
      }
      commit(result.system);
      set({ notice: undefined });
    },

    unlink: (edgeId) => edit((system) => removeEdge(system, edgeId)),
    drop: (nodeId) => {
      edit((system) => removeNode(system, nodeId));
      if (get().selectedNodeId === nodeId) set({ selectedNodeId: undefined });
    },

    // Position changes are committed on drag stop, so one drag is one undo step
    // rather than one per animation frame.
    moveNode: (nodeId, position) =>
      edit((system) => ({
        ...system,
        nodes: system.nodes.map((n) => (n.id === nodeId ? { ...n, position } : n)),
      })),

    rename: (nodeId, name) => edit((system) => renameNode(system, nodeId, name)),
    editWorker: (nodeId, patch) => edit((system) => patchWorker(system, nodeId, patch)),
    editBinding: (edgeId, bindingName) =>
      edit((system) => renameBinding(system, edgeId, bindingName)),
    setNodeConfig: (nodeId, patch) =>
      edit((system) => patchNodeConfig(system, nodeId, patch)),
    setEdgeConfig: (edgeId, patch) =>
      edit((system) => patchEdgeConfig(system, edgeId, patch)),
    setConsumer: (edgeId, patch) =>
      edit((system) => patchConsumer(system, edgeId, patch)),

    undo: () => {
      const { past, system } = get();
      const previous = past[past.length - 1];
      if (!previous || !system) return;
      set({
        system: previous,
        past: past.slice(0, -1),
        future: [system, ...get().future].slice(0, HISTORY_LIMIT),
      });
    },

    redo: () => {
      const { future, system } = get();
      const next = future[0];
      if (!next || !system) return;
      set({
        system: next,
        past: [...get().past, system].slice(-HISTORY_LIMIT),
        future: future.slice(1),
      });
    },

    relayout: async () => {
      const system = get().system;
      if (!system) return;
      // A re-layout discards manual placement on purpose, so positions are
      // cleared before laying out rather than preserved as they are on load.
      const positions = await layoutSystem(system);
      commit({
        ...system,
        nodes: system.nodes.map((n) => ({
          ...n,
          position: positions.get(n.id) ?? n.position ?? { x: 0, y: 0 },
        })),
      });
    },



    exportRepo: async (outDir) => {
      const system = get().system;
      if (!system) return;
      set({ loading: true, error: undefined });
      try {
        const response = await fetch("/api/export", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ system, ...(outDir.trim() ? { outDir } : {}) }),
        });
        const body = (await response.json()) as {
          outDir?: string;
          written?: string[];
          warnings?: string[];
          error?: string;
        };
        if (!response.ok || body.error) {
          set({ loading: false, error: body.error ?? "Export failed." });
          return;
        }
        set({
          loading: false,
          notice: [
            `Wrote ${body.written?.length ?? 0} file(s) to ${body.outDir}.`,
            ...(body.warnings ?? []),
          ].join(" "),
        });
      } catch (error) {
        set({ loading: false, error: (error as Error).message });
      }
    },

    refreshActivity: async () => {
      try {
        const response = await fetch("/api/activity?hours=24");
        const body = (await response.json()) as {
          activity?: { scriptName: string; requests: number; errors: number }[];
          warnings?: string[];
        };
        const byName: Record<string, { requests: number; errors: number }> = {};
        for (const row of body.activity ?? []) {
          byName[row.scriptName] = { requests: row.requests, errors: row.errors };
        }
        set({ activity: byName, activityWarnings: body.warnings ?? [] });
      } catch (error) {
        set({ activityWarnings: [(error as Error).message] });
      }
    },

    /**
     * Write the project to disk.
     *
     * Called on create and again whenever the design settles, so the folder is
     * always a faithful projection of the canvas.
     */
    scaffold: async (folder) => {
      const system = get().system;
      if (!system) return;
      const target = folder?.trim() || get().projectFolder;

      try {
        const response = await fetch("/api/scaffold", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ system, ...(target ? { folder: target } : {}) }),
        });
        const body = (await response.json()) as {
          folder?: string;
          written?: string[];
          created?: string[];
          preserved?: string[];
          error?: string;
        };
        if (!response.ok || body.error) {
          set({ error: body.error ?? "Could not write the project." });
          return;
        }
        set({
          projectFolder: body.folder,
          dirty: false,
          error: undefined,
          notice: `${body.created?.length ?? 0} file(s) created, ${
            body.written?.length ?? 0
          } regenerated${
            body.preserved?.length ? `, ${body.preserved.length} left alone` : ""
          } in ${body.folder}`,
        });
      } catch (error) {
        set({ error: (error as Error).message });
      }
    },

    /**
     * Open a folder flarecraft owns: read it back and bind it for future writes.
     *
     * This is the other half of the round trip. You leave to write handlers or
     * hand-edit a config; coming back, the folder is the truth and the canvas
     * is rebuilt from it. Distinct from a plain scan, which maps a tree of
     * unrelated repositories and binds nothing.
     */
    openProject: async (folder) => {
      set({ loading: true, error: undefined });
      try {
        const response = await fetch(
          `/api/system/repo?root=${encodeURIComponent(folder)}`,
        );
        const body = (await response.json()) as SystemResponse;
        if (!response.ok || body.error) {
          set({ loading: false, error: body.error ?? "Could not open that folder." });
          return;
        }
        // A directory scan names itself "Local repositories", which is right
        // for a tree of unrelated repos and wrong for one project. The folder
        // is the better name here.
        // Both separators: a Windows path arrives with backslashes, and a
        // forward-slash-only pattern silently never splits it.
        const projectName =
          folder
            .replace(/[\\/]+$/, "")
            .split(/[\\/]/)
            .pop() || body.system.name;

        set({
          system: { ...(await applyLayout(body.system)), name: projectName },
          warnings: body.warnings ?? [],
          configPaths: body.configPaths ?? [],
          projectFolder: folder,
          source: "repo",
          loading: false,
          // Not dirty: the model came from these files, so there is nothing to
          // write back until something actually changes.
          dirty: false,
          past: [],
          future: [],
          selectedNodeId: undefined,
        });
      } catch (error) {
        set({ loading: false, error: (error as Error).message });
      }
    },

    /** Back to the start screen, discarding the loaded system. */
    reset: () =>
      set({
        system: undefined,
        past: [],
        future: [],
        warnings: [],
        drift: [],
        configPaths: [],
        covered: [],
        source: undefined,
        selectedNodeId: undefined,
        error: undefined,
        notice: undefined,
        projectFolder: undefined,
        dirty: false,
      }),

    checkDrift: async (root) => {
      set({ loading: true, error: undefined, drift: [] });
      try {
        const response = await fetch(`/api/drift?root=${encodeURIComponent(root)}`);
        const body = (await response.json()) as {
          findings?: { kind: string; severity: string; message: string; remedy?: string }[];
          error?: string;
          detail?: string;
        };
        if (!response.ok || body.error) {
          set({ loading: false, error: [body.error, body.detail].filter(Boolean).join(" ") });
          return;
        }
        set({
          loading: false,
          drift: (body.findings ?? []).map((f) => ({
            code: `${f.severity}: ${f.kind}`,
            message: f.remedy ? `${f.message} ${f.remedy}` : f.message,
          })),
          notice:
            body.findings?.length === 0
              ? "No drift between your configs and the account."
              : `${body.findings?.length} drift finding(s).`,
        });
      } catch (error) {
        set({ loading: false, error: (error as Error).message });
      }
    },

  };
});

async function load(
  set: (partial: Partial<StudioState>) => void,
  url: string,
  source: SourceKind,
): Promise<void> {
  set({ loading: true, error: undefined });
  try {
    const response = await fetch(url);
    const body = (await response.json()) as SystemResponse;

    if (!response.ok || body.error) {
      set({ loading: false, error: [body.error, body.detail].filter(Boolean).join(" ") });
      return;
    }

    set({
      system: await applyLayout(body.system),
      warnings: body.warnings ?? [],
      covered: body.covered ?? [],
      configPaths: body.configPaths ?? [],
      source,
      loading: false,
      // A fresh scan is a new starting point, not something to undo back past.
      past: [],
      future: [],
      selectedNodeId: undefined,
    });
  } catch (error) {
    set({
      loading: false,
      error: `Could not reach the flarecraft server. Is it running? (${(error as Error).message})`,
    });
  }
}

/** Seed positions for nodes that do not have one; never move a placed node. */
async function applyLayout(system: SystemModel): Promise<SystemModel> {
  const positions = await layoutSystem(system);
  return {
    ...system,
    nodes: system.nodes.map((node) => ({
      ...node,
      position: node.position ?? positions.get(node.id) ?? { x: 0, y: 0 },
    })),
  };
}
