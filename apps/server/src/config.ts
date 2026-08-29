import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Local machine config, deliberately outside the repo.
 *
 * `~/.flarecraft/config.json`:
 * {
 *   "cloudflare": { "apiToken": "...", "accountId": "..." },
 *   "anthropic":  { "apiKey": "..." },
 *   "scanRoots":  ["C:/Users/you/Documents"]
 * }
 *
 * The token is read here and used here. It is never written into the repo,
 * never returned by an endpoint, and never sent to the browser — the studio
 * asks this server for a topology and gets a topology back, nothing else.
 */

export interface FlarecraftConfig {
  cloudflare?: { apiToken?: string; accountId?: string };
  anthropic?: { apiKey?: string };
  scanRoots?: string[];
}

export const CONFIG_PATH = join(homedir(), ".flarecraft", "config.json");

export async function loadConfig(): Promise<FlarecraftConfig> {
  try {
    return JSON.parse(await readFile(CONFIG_PATH, "utf8")) as FlarecraftConfig;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(
      `${CONFIG_PATH} exists but could not be read as JSON: ${(error as Error).message}`,
    );
  }
}

/** What the browser is allowed to know: whether a credential exists, never its value. */
export interface ConfigStatus {
  configPath: string;
  hasCloudflareToken: boolean;
  hasAnthropicKey: boolean;
  accountId?: string;
  scanRoots: string[];
}

export function describeConfig(config: FlarecraftConfig): ConfigStatus {
  return {
    configPath: CONFIG_PATH,
    hasCloudflareToken: Boolean(config.cloudflare?.apiToken),
    hasAnthropicKey: Boolean(config.anthropic?.apiKey),
    ...(config.cloudflare?.accountId ? { accountId: config.cloudflare.accountId } : {}),
    scanRoots: config.scanRoots ?? [],
  };
}
