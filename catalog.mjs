import { createHash } from "node:crypto";
import { parse } from "yaml";

const protocol = "2025-11-25";
const categories = new Set([
  "experience",
  "accessibility",
  "discoverability",
  "technical",
]);
const checkId = /^[a-z0-9][a-z0-9._-]*$/;

export function mcpEndpoint(value) {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !/^\/api\/glue\/projects\/[a-z0-9][a-z0-9-]*\/mcp$/.test(url.pathname)
  ) {
    throw new Error("GLUE_MCP_URL must be a Glue project HTTPS MCP endpoint.");
  }
  return url;
}

export function glueClient(
  endpoint,
  token,
  { request = fetch, vercelBypass } = {},
) {
  let id = 0;
  async function rpc(method, params) {
    const notification = method === "notifications/initialized";
    const message = {
      jsonrpc: "2.0",
      method,
      params,
      ...(notification ? {} : { id: ++id }),
    };
    const response = await request(endpoint, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(60_000),
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": protocol,
        ...(vercelBypass ? { "x-vercel-protection-bypass": vercelBypass } : {}),
      },
      body: JSON.stringify(message),
    });
    if (response.status === 401 || response.status === 403) {
      throw new Error(
        "Glue denied MCP access. Verify the repository customer token and its Store Skills Pro access.",
      );
    }
    if (!response.ok)
      throw new Error(`Glue MCP ${method} returned HTTP ${response.status}.`);
    if (notification) return;
    const { id: replyId, result, error } = await response.json();
    if (error || replyId !== message.id || !result)
      throw new Error(`Glue MCP ${method} failed.`);
    return result;
  }

  return {
    async connect() {
      const result = await rpc("initialize", {
        protocolVersion: protocol,
        capabilities: {},
        clientInfo: { name: "storeskills-action", version: "1.0.0" },
      });
      if (result.protocolVersion !== protocol)
        throw new Error("Glue negotiated an unsupported MCP version.");
      await rpc("notifications/initialized", {});
      const { tools } = await rpc("tools/list", {});
      if (
        !["find_checks", "read_page"].every((name) =>
          tools?.some((tool) => tool.name === name),
        )
      ) {
        throw new Error(
          "Store Skills MCP must expose find_checks and read_page. Check Pro access and the published release.",
        );
      }
    },
    async call(name, args) {
      const result = await rpc("tools/call", { name, arguments: args });
      if (result.isError || !result.structuredContent) {
        throw new Error(
          `Glue MCP ${name} failed. Check the published release and the customer's Pro access.`,
        );
      }
      return result.structuredContent;
    },
  };
}

export async function collectCatalog(client, saveCheck) {
  await client.connect();
  const selected = new Map();
  const addresses = new Set();
  const cursors = new Set();
  let cursor;
  let total;
  do {
    const result = await client.call("find_checks", {
      status: "active",
      ...(cursor ? { cursor } : {}),
    });
    if (result.total === 0)
      throw new Error(
        "Store Skills MCP returned no active Checks. Verify Pro access.",
      );
    total ??= result.total;
    if (
      !Number.isSafeInteger(total) ||
      total < 1 ||
      total !== result.total ||
      !Array.isArray(result.pages) ||
      !result.pages.length
    ) {
      throw new Error("Store Skills MCP returned an inconsistent catalog.");
    }
    for (const { page, path, title, fields } of result.pages) {
      const id = fields?.id;
      const version = Number(fields?.version);
      if (
        typeof id !== "string" ||
        !checkId.test(id) ||
        selected.has(id) ||
        !Number.isSafeInteger(version) ||
        version < 1 ||
        !title ||
        typeof page !== "string" ||
        !page ||
        addresses.has(page) ||
        typeof path !== "string" ||
        !path.startsWith("comprehensive-checks/") ||
        selected.size >= total
      )
        throw new Error(
          "Store Skills MCP returned an invalid or duplicate Check.",
        );
      addresses.add(page);
      selected.set(id, { id, version, title, page, path });
    }
    cursor = result.nextCursor;
    if (
      cursor != null &&
      (typeof cursor !== "string" || !cursor || cursors.has(cursor))
    ) {
      throw new Error(
        "Store Skills MCP returned an invalid pagination cursor.",
      );
    }
    if (cursor) cursors.add(cursor);
  } while (cursor);
  if (selected.size !== total)
    throw new Error("Store Skills MCP returned an incomplete catalog.");

  const checks = [...selected.keys()].sort().map((id) => selected.get(id));
  for (let offset = 0; offset < checks.length; ) {
    const batch = checks.slice(offset, offset + 20);
    const { pages } = await client.call("read_page", {
      pages: batch.map(({ page }) => page),
    });
    if (!Array.isArray(pages) || pages.length !== batch.length)
      throw new Error("Store Skills MCP returned an incomplete Check batch.");
    let read = 0;
    for (const [index, result] of pages.entries()) {
      const check = batch[index];
      if (result.slug !== check.page)
        throw new Error(
          "Store Skills MCP returned an unexpected Check address.",
        );
      if (result.deferred) break;
      const header =
        typeof result.markdown === "string" &&
        result.markdown.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
      if (!header || result.unavailable) {
        throw new Error(
          "A selected Check is unavailable. Verify the customer has access to the full catalog.",
        );
      }
      let metadata;
      try {
        metadata = parse(header[1]);
      } catch {
        throw new Error("Store Skills MCP returned invalid Check frontmatter.");
      }
      if (
        metadata?.id !== check.id ||
        metadata.version !== check.version ||
        metadata.status !== "active" ||
        !categories.has(metadata.category)
      )
        throw new Error(
          "A Store Skills Check changed during catalog collection. Rerun against a stable release.",
        );
      check.category = metadata.category;
      check.sha256 = createHash("sha256").update(result.markdown).digest("hex");
      await saveCheck(check, result.markdown);
      read++;
    }
    if (!read)
      throw new Error("Store Skills MCP deferred the entire Check batch.");
    offset += read;
  }
  return checks;
}
