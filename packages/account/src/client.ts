/**
 * Minimal read-only Cloudflare REST client.
 *
 * Deliberately does not use the official SDK: the scan touches a dozen product
 * APIs, several of which the token may not be scoped for, and the behaviour
 * that matters most is degrading cleanly when one of them says 403. A thin
 * client that reports per-endpoint failures as warnings gets that right; a
 * generated SDK that throws on the first refusal would abort the whole scan
 * because the account happens not to use Vectorize.
 */

const API_BASE = "https://api.cloudflare.com/client/v4";

export interface CloudflareError {
  code: number;
  message: string;
}

interface Envelope<T> {
  result: T;
  success: boolean;
  errors: CloudflareError[];
  result_info?: {
    page: number;
    per_page: number;
    total_count: number;
    total_pages?: number;
  };
}

export class CloudflareApiError extends Error {
  constructor(
    override readonly message: string,
    readonly status: number,
    readonly path: string,
    readonly errors: CloudflareError[] = [],
  ) {
    super(message);
    this.name = "CloudflareApiError";
  }
}

export interface ClientOptions {
  apiToken: string;
  fetchImpl?: typeof fetch;
  /** Injected in tests; keeps the scan deterministic without network access. */
  baseUrl?: string;
}

export class CloudflareClient {
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;

  constructor(options: ClientOptions) {
    this.token = options.apiToken;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.baseUrl = options.baseUrl ?? API_BASE;
  }

  async get<T>(path: string, query: Record<string, string> = {}): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, value);
    }

    const response = await this.fetchImpl(url.toString(), {
      headers: {
        // The token is never logged and never leaves this process — the studio
        // talks to the local server, which holds it, rather than the API.
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
    });

    let body: Envelope<T> | undefined;
    try {
      body = (await response.json()) as Envelope<T>;
    } catch {
      throw new CloudflareApiError(
        `Non-JSON response (HTTP ${response.status})`,
        response.status,
        path,
      );
    }

    if (!response.ok || !body.success) {
      const errors = body.errors ?? [];
      throw new CloudflareApiError(
        errors[0]?.message ?? `HTTP ${response.status}`,
        response.status,
        path,
        errors,
      );
    }
    return body.result;
  }

  /**
   * Follow `result_info` pagination to completion.
   *
   * `hardLimit` is a stop, not an optimisation: an account with a Workers for
   * Platforms dispatch namespace can hold tens of thousands of scripts, and a
   * scan that tries to draw all of them is useless anyway.
   */
  async list<T>(
    path: string,
    query: Record<string, string> = {},
    hardLimit = 2000,
  ): Promise<T[]> {
    const perPage = 100;
    const items: T[] = [];
    let page = 1;

    for (;;) {
      const url = new URL(`${this.baseUrl}${path}`);
      for (const [key, value] of Object.entries(query)) {
        url.searchParams.set(key, value);
      }
      url.searchParams.set("page", String(page));
      url.searchParams.set("per_page", String(perPage));

      const response = await this.fetchImpl(url.toString(), {
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
        },
      });

      const body = (await response.json()) as Envelope<T[]>;
      if (!response.ok || !body.success) {
        throw new CloudflareApiError(
          body.errors?.[0]?.message ?? `HTTP ${response.status}`,
          response.status,
          path,
          body.errors ?? [],
        );
      }

      const batch = Array.isArray(body.result) ? body.result : [];
      items.push(...batch);

      const info = body.result_info;
      const morePages = info?.total_pages ? page < info.total_pages : batch.length === perPage;
      if (!morePages || items.length >= hardLimit || batch.length === 0) break;
      page += 1;
    }

    return items.slice(0, hardLimit);
  }
}
