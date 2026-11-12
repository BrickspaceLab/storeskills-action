import assert from "node:assert/strict";
import test from "node:test";
import { collectCatalog, glueClient, mcpEndpoint } from "./catalog.mjs";
import { validateReport } from "./report.mjs";

const endpoint = mcpEndpoint(
  "https://glue.example/api/glue/projects/storeskills/mcp",
);
const entry = (id) => ({
  page: id,
  title: id,
  path: `comprehensive-checks/${id}.md`,
  fields: { id, version: "1" },
});
const body = (id, version = 1) =>
  `---\nid: ${id}\nversion: ${version}\nstatus: active\ncategory: experience\n---\n# ${id}\n`;

function server(callTool) {
  const request = async (url, init) => {
    assert.equal(url, endpoint);
    assert.equal(init.redirect, "error");
    assert.equal(init.headers.Authorization, "Bearer test-token");
    assert.equal(init.headers["x-vercel-protection-bypass"], "test-protection");
    const { id, method, params } = JSON.parse(init.body);
    let result;
    switch (method) {
      case "initialize":
        result = { protocolVersion: params.protocolVersion };
        break;
      case "notifications/initialized":
        return new Response(null, { status: 202 });
      case "tools/list":
        result = { tools: [{ name: "find_checks" }, { name: "read_page" }] };
        break;
      case "tools/call":
        result = { structuredContent: callTool(params.name, params.arguments) };
        break;
      default:
        assert.fail(`Unexpected MCP method ${method}`);
    }
    return Response.json({ jsonrpc: "2.0", id, result });
  };
  return glueClient(endpoint, "test-token", {
    request,
    vercelBypass: "test-protection",
  });
}

test("fetches every active Check across catalog pages and retries deferred bodies", async () => {
  const calls = [];
  const client = server((name, args) => {
    calls.push([name, args]);
    if (name === "find_checks") {
      return args.cursor
        ? { total: 3, pages: [entry("b")] }
        : { total: 3, pages: [entry("c"), entry("a")], nextCursor: "more" };
    }
    return {
      pages: args.pages.map((slug, index) =>
        index > 0 ? { slug, deferred: true } : { slug, markdown: body(slug) },
      ),
    };
  });
  const saved = [];
  const checks = await collectCatalog(client, ({ id }, markdown) =>
    saved.push([id, markdown]),
  );
  assert.deepEqual(
    saved,
    ["a", "b", "c"].map((id) => [id, body(id)]),
  );
  assert.deepEqual(
    checks.map(({ category }) => category),
    Array(3).fill("experience"),
  );
  assert.deepEqual(calls, [
    ["find_checks", { status: "active" }],
    ["find_checks", { status: "active", cursor: "more" }],
    ["read_page", { pages: ["a", "b", "c"] }],
    ["read_page", { pages: ["b", "c"] }],
    ["read_page", { pages: ["c"] }],
  ]);
});

test("stops when the subscription cannot read Checks or the catalog changes", async () => {
  const noAccess = glueClient(endpoint, "test-token", {
    request: async () => new Response(null, { status: 403 }),
  });
  await assert.rejects(
    collectCatalog(noAccess, () => assert.fail()),
    /denied MCP access/,
  );
  const changing = server((name) =>
    name === "find_checks"
      ? { total: 1, pages: [entry("a")] }
      : { pages: [{ slug: "a", markdown: body("a", 2) }] },
  );
  await assert.rejects(
    collectCatalog(changing, () => assert.fail()),
    /changed during catalog collection/,
  );
  assert.throws(
    () =>
      mcpEndpoint(
        "https://glue.example/api/glue/projects/storeskills/mcp?token=unsafe",
      ),
    /HTTPS MCP endpoint/,
  );
});

test("validates every selected Check and its Issue and Limitation references", () => {
  const schema = {
    type: "object",
    required: ["runtime"],
    properties: { runtime: { const: "glue-review/v19" } },
  };
  const checks = ["a", "b", "c"].map((id) => ({ id, category: "experience" }));
  const makeOutcome = (id, status, issueIds = [], limitationIds = []) => ({
    coverageIds: [id],
    status,
    detail: "Route and observed evidence",
    issueIds,
    limitationIds,
    dataIds: [],
    findingIds: [],
  });
  const report = {
    runtime: "glue-review/v19",
    data: [],
    findings: [],
    strengths: [],
    changes: [],
    issues: [{ id: "issue", category: "experience" }],
    limitations: [{ id: "access", affectedCoverageIds: ["b"] }],
    coverageOutcomes: [
      makeOutcome("a", "fail", ["issue"]),
      makeOutcome("b", "blocked", [], ["access"]),
      makeOutcome("c", "pass"),
    ],
  };
  assert.deepEqual(validateReport(report, schema, checks), {
    pass: 1,
    fail: 1,
    blocked: 1,
    not_applicable: 0,
  });
  assert.throws(
    () => validateReport({ ...report, runtime: "invalid" }, schema, checks),
    /bundled Glue result schema/,
  );
  assert.throws(
    () =>
      validateReport(
        { ...report, coverageOutcomes: report.coverageOutcomes.slice(0, 2) },
        schema,
        checks,
      ),
    /1 selected Checks have no outcome/,
  );
  assert.throws(
    () =>
      validateReport(
        { ...report, issues: [{ id: "issue", category: "technical" }] },
        schema,
        checks,
      ),
    /same-category Issue/,
  );
  assert.throws(
    () =>
      validateReport(
        {
          ...report,
          limitations: [{ id: "access", affectedCoverageIds: ["c"] }],
        },
        schema,
        checks,
      ),
    /both directions/,
  );
});
