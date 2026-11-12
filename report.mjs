import Ajv from "ajv";

export function validateReport(report, schema, checks) {
  const validate = new Ajv({ strict: false }).compile(schema);
  if (!validate(report))
    throw new Error(
      "The audit report did not match the bundled Glue result schema.",
    );
  if (
    report.data.length ||
    report.findings.length ||
    report.strengths.length ||
    report.changes.length ||
    "score" in report
  ) {
    throw new Error(
      "The audit returned results outside its declared output or without a comparison baseline.",
    );
  }

  const catalog = new Map(checks.map(({ id, category }) => [id, category]));
  const issues = indexById(report.issues);
  const limitations = indexById(report.limitations);
  const issueRefs = new Set();
  const affected = new Map();
  for (const [id, { affectedCoverageIds }] of limitations) {
    const ids = new Set(affectedCoverageIds);
    if (ids.size !== affectedCoverageIds.length)
      throw new Error("A Limitation references the same Check more than once.");
    affected.set(id, ids);
  }
  const outcomes = { pass: 0, fail: 0, blocked: 0, not_applicable: 0 };
  for (const outcome of report.coverageOutcomes) {
    const {
      status,
      detail,
      issueIds,
      limitationIds,
      coverageIds,
      dataIds,
      findingIds,
    } = outcome;
    if (
      !Object.hasOwn(outcomes, status) ||
      !detail?.trim() ||
      dataIds.length ||
      findingIds.length
    ) {
      throw new Error(
        "Every Check needs a terminal outcome with audit evidence or a specific limitation.",
      );
    }
    if (
      issueIds.length !== Number(status === "fail") ||
      (status === "blocked" ? !limitationIds.length : limitationIds.length)
    ) {
      throw new Error(
        "A Check outcome has missing or incompatible Issue or Limitation references.",
      );
    }
    for (const id of coverageIds) {
      const category = catalog.get(id);
      if (!category)
        throw new Error(
          "The report contains a duplicate or unknown Check outcome.",
        );
      catalog.delete(id);
      for (const issueId of issueIds) {
        if (issues.get(issueId)?.category !== category)
          throw new Error(
            "A failed Check must reference a same-category Issue.",
          );
        issueRefs.add(issueId);
      }
      for (const limitationId of limitationIds) {
        if (!affected.get(limitationId)?.delete(id))
          throw new Error(
            "Check and Limitation references must match in both directions.",
          );
      }
      outcomes[status]++;
    }
  }

  if (catalog.size)
    throw new Error(
      `The audit is incomplete. ${catalog.size} selected Checks have no outcome.`,
    );
  if (
    issueRefs.size !== issues.size ||
    [...affected.values()].some((ids) => ids.size)
  ) {
    throw new Error("The report contains an unreferenced Issue or Limitation.");
  }
  if (outcomes.blocked === checks.length)
    throw new Error("The audit could not evaluate any selected Checks.");
  return outcomes;
}

function indexById(items) {
  const index = new Map(items.map((item) => [item.id, item]));
  if (index.size !== items.length)
    throw new Error("The audit report contains duplicate result IDs.");
  return index;
}
