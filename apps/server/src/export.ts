import { mkdir, readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { emitRepo } from "@flarecraft/wrangler-io";
import type { SystemModel } from "@flarecraft/model";

/**
 * Write an emitted repo to disk.
 *
 * This is the only endpoint that creates files, so it is the one place where a
 * malformed request could do real damage. Three checks stand in the way: the
 * destination must be absolute, it must be empty unless the caller explicitly
 * says otherwise, and every file is verified to land inside it before anything
 * is written.
 */

export const DEFAULT_EXPORT_ROOT = join(homedir(), ".flarecraft", "exports");

export class ExportError extends Error {}

export interface ExportRequest {
  system: SystemModel;
  /** Absolute destination. Defaults to ~/.flarecraft/exports/<system name>. */
  outDir?: string;
  /** Write into a directory that already has files in it. */
  force?: boolean;
}

export interface ExportResult {
  outDir: string;
  written: string[];
  warnings: string[];
}

const slug = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "system";

export async function exportRepo(request: ExportRequest): Promise<ExportResult> {
  const outDir = resolve(
    request.outDir?.trim() ||
      join(DEFAULT_EXPORT_ROOT, slug(request.system.name ?? "system")),
  );

  if (request.outDir && !isAbsolute(request.outDir.trim())) {
    throw new ExportError("The destination must be an absolute path.");
  }

  // Refusing to write into an occupied directory is the difference between a
  // generated scaffold and an overwritten project.
  if (!request.force) {
    try {
      const existing = await readdir(outDir);
      if (existing.length > 0) {
        throw new ExportError(
          `${outDir} is not empty. Choose an empty directory, or re-run with force to write into it anyway.`,
        );
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  const { files, warnings } = emitRepo(request.system);
  if (files.length === 0) throw new ExportError("Nothing to export.");

  const written: string[] = [];
  for (const file of files) {
    const target = resolve(outDir, file.path);

    // Every path here is generated, not user-supplied — but a name that
    // escapes the destination would be silent and catastrophic, so it is
    // checked rather than assumed.
    const inside = relative(outDir, target);
    if (inside.startsWith("..") || isAbsolute(inside) || inside.split(sep)[0] === "..") {
      throw new ExportError(`Refusing to write outside the destination: ${file.path}`);
    }

    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.contents, "utf8");
    written.push(file.path);
  }

  return { outDir, written, warnings };
}
