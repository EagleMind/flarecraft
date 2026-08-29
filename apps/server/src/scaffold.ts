import { access, mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { scaffoldProject } from "@flarecraft/wrangler-io";
import type { SystemModel } from "@flarecraft/model";
import { ExportError } from "./export.js";

/**
 * Write a project to a folder, and keep writing it as the design changes.
 *
 * The rule that makes this safe to run over and over: flarecraft rewrites only
 * the files that are a projection of the topology, and creates the rest exactly
 * once. A scaffold that overwrote an edited handler would have cost more than
 * it gave, so the split is enforced here rather than left to a confirmation
 * dialog nobody reads.
 */

export interface ScaffoldRequest {
  system: SystemModel;
  folder: string;
}

export interface ScaffoldResponse {
  folder: string;
  /** Regenerated from the topology on this run. */
  written: string[];
  /** Created because they did not exist yet. */
  created: string[];
  /** Yours already, so left exactly as they were. */
  preserved: string[];
  warnings: string[];
}

const exists = async (path: string): Promise<boolean> => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

export async function scaffoldToFolder(
  request: ScaffoldRequest,
): Promise<ScaffoldResponse> {
  const folder = request.folder?.trim();
  if (!folder) throw new ExportError("No folder given.");
  if (!isAbsolute(folder)) {
    throw new ExportError("The project folder must be an absolute path.");
  }

  const root = resolve(folder);
  const { files, warnings } = scaffoldProject(request.system);

  const written: string[] = [];
  const created: string[] = [];
  const preserved: string[] = [];

  for (const file of files) {
    const target = resolve(root, file.path);

    // Paths here are generated, not user-supplied, but one escaping the folder
    // would be silent and unrecoverable — so it is checked, not assumed.
    const inside = relative(root, target);
    if (inside.startsWith("..") || isAbsolute(inside) || inside.split(sep)[0] === "..") {
      throw new ExportError(`Refusing to write outside the project: ${file.path}`);
    }

    const present = await exists(target);

    if (present && !file.owned) {
      preserved.push(file.path);
      continue;
    }

    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.contents, "utf8");
    (present ? written : created).push(file.path);
  }

  return { folder: root, written, created, preserved, warnings };
}

/** Where a new project goes when the user does not name a folder. */
export function defaultProjectFolder(home: string, name: string): string {
  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "system";
  return join(home, ".flarecraft", "projects", slug);
}
