/**
 * Live Worker activity from the GraphQL Analytics API.
 *
 * Separate from the REST client because it is a different API with a different
 * shape: one endpoint, one POST, a query rather than a path.
 *
 * What you can see depends on the plan and on the token's scopes, and there is
 * no reliable way to ask in advance which. So a failure here is reported, never
 * thrown — an account that cannot serve analytics should still render its
 * topology rather than showing an error page.
 */

const GRAPHQL_ENDPOINT = "https://api.cloudflare.com/client/v4/graphql";

export interface WorkerActivity {
  scriptName: string;
  requests: number;
  errors: number;
  subrequests: number;
  cpuTimeP50?: number;
  cpuTimeP99?: number;
}

export interface ActivityResult {
  activity: WorkerActivity[];
  since: string;
  until: string;
  /** Why the picture is incomplete, when it is. */
  warnings: string[];
}

/**
 * Grouped by scriptName rather than filtered to one, so a single request covers
 * the whole canvas. The dimensions block is what makes the grouping possible.
 */
const QUERY = `
query WorkerActivity($accountTag: string, $start: string, $end: string) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      workersInvocationsAdaptive(
        limit: 10000
        filter: { datetime_geq: $start, datetime_leq: $end }
      ) {
        sum { requests errors subrequests }
        quantiles { cpuTimeP50 cpuTimeP99 }
        dimensions { scriptName }
      }
    }
  }
}`;

interface GraphQLRow {
  sum?: { requests?: number; errors?: number; subrequests?: number };
  quantiles?: { cpuTimeP50?: number; cpuTimeP99?: number };
  dimensions?: { scriptName?: string };
}

export async function fetchWorkerActivity(options: {
  apiToken: string;
  accountId: string;
  /** How far back to look. Cloudflare retains Worker metrics for months. */
  hours?: number;
  fetchImpl?: typeof fetch;
}): Promise<ActivityResult> {
  const hours = options.hours ?? 24;
  const until = new Date();
  const since = new Date(until.getTime() - hours * 3_600_000);
  const warnings: string[] = [];

  const doFetch = options.fetchImpl ?? fetch;

  let body: {
    data?: { viewer?: { accounts?: { workersInvocationsAdaptive?: GraphQLRow[] }[] } };
    errors?: { message: string }[];
  };

  try {
    const response = await doFetch(GRAPHQL_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${options.apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query: QUERY,
        variables: {
          accountTag: options.accountId,
          start: since.toISOString(),
          end: until.toISOString(),
        },
      }),
    });
    body = (await response.json()) as typeof body;
  } catch (error) {
    return {
      activity: [],
      since: since.toISOString(),
      until: until.toISOString(),
      warnings: [`Could not reach the Analytics API: ${(error as Error).message}`],
    };
  }

  // GraphQL returns 200 with an errors array rather than an HTTP status, so
  // checking response.ok alone would silently report zero traffic.
  if (body.errors?.length) {
    warnings.push(
      `Analytics API: ${body.errors.map((e) => e.message).join("; ")}. Worker metrics need a token with Account Analytics read, and some datasets are plan-gated.`,
    );
  }

  const rows = body.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive ?? [];

  // Rows arrive per scriptName already, but a status dimension can split one
  // script across several — summing defensively costs nothing.
  const byScript = new Map<string, WorkerActivity>();
  for (const row of rows) {
    const scriptName = row.dimensions?.scriptName;
    if (!scriptName) continue;

    const existing = byScript.get(scriptName) ?? {
      scriptName,
      requests: 0,
      errors: 0,
      subrequests: 0,
    };
    existing.requests += row.sum?.requests ?? 0;
    existing.errors += row.sum?.errors ?? 0;
    existing.subrequests += row.sum?.subrequests ?? 0;
    if (row.quantiles?.cpuTimeP50 !== undefined) {
      existing.cpuTimeP50 = row.quantiles.cpuTimeP50;
    }
    if (row.quantiles?.cpuTimeP99 !== undefined) {
      existing.cpuTimeP99 = row.quantiles.cpuTimeP99;
    }
    byScript.set(scriptName, existing);
  }

  if (rows.length === 0 && warnings.length === 0) {
    warnings.push(
      `No invocations recorded in the last ${hours}h. Either nothing ran, or this account's plan does not expose the dataset.`,
    );
  }

  return {
    activity: [...byScript.values()].sort((a, b) => b.requests - a.requests),
    since: since.toISOString(),
    until: until.toISOString(),
    warnings,
  };
}
