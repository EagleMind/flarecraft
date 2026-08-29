/**
 * Drive the MCP server over a real stdio transport.
 *
 * Typechecking proves the tools compile; only speaking the protocol proves a
 * client can list them and get an answer back.
 *
 *   pnpm tsx scripts/verify-mcp.ts [scanRoot]
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = process.argv[2] ?? "C:/Users/Hassen/Documents";

const transport = new StdioClientTransport({
  command: "npx",
  args: ["tsx", "apps/mcp/src/index.ts"],
});

const client = new Client({ name: "flarecraft-verify", version: "0.1.0" });
await client.connect(transport);

const { tools } = await client.listTools();
console.log(`tools (${tools.length}):`);
for (const tool of tools) console.log(`  ${tool.name} — ${tool.title ?? ""}`);

const firstText = (result: unknown): string => {
  const content = (result as { content?: { type: string; text?: string }[] }).content;
  return content?.find((c) => c.type === "text")?.text ?? "(no text)";
};

const show = (heading: string, body: string, lines = 14) => {
  console.log(`\n─── ${heading} ───`);
  console.log(body.split("\n").slice(0, lines).join("\n"));
};

show(
  "choose_primitive: per-entity serialized writes",
  firstText(
    await client.callTool({
      name: "choose_primitive",
      arguments: {
        shape: "request",
        serialization: "required",
        cardinality: "per-entity",
        consistency: "read-after-write",
        access: "relational",
      },
    }),
  ),
  18,
);

show(
  "who_binds: HYPERDRIVE",
  firstText(
    await client.callTool({ name: "who_binds", arguments: { root, name: "HYPERDRIVE" } }),
  ),
);

show(
  "lint_topology",
  firstText(await client.callTool({ name: "lint_topology", arguments: { root } })),
  8,
);

show(
  "diff_deployed (no token expected)",
  firstText(await client.callTool({ name: "diff_deployed", arguments: { root } })),
  4,
);

await client.close();
console.log("\nMCP server responded to every tool call.");
