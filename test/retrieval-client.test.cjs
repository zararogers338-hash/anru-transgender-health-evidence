const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const { RetrievalClient, ftsExpression } = require("../electron/retrieval-client.cjs");

test("Anru bundled corpus opens and returns traceable transgender-health evidence", async () => {
  const client = new RetrievalClient({ skillPath: path.join(__dirname, "..", "resources", "anru") });
  try {
    await client.start();
    const health = await client.call("health");
    assert.ok(health.papers >= 1000);
    assert.ok(health.journals >= 3);
    const result = await client.call("search", { query: "跨性别 激素 心血管风险", topK: 3 });
    assert.equal(result.retrieval_mode, "fts5-bm25");
    assert.ok(result.results.length > 0);
    assert.match(result.results[0].citation_url, /^https:\/\//);
    assert.ok(result.results[0].pmid || result.results[0].doi);
  } finally {
    await client.stop();
  }
});

test("Chinese transgender-health queries expand to English biomedical terms", () => {
  const expression = ftsExpression("跨性别激素治疗心血管风险");
  assert.match(expression, /transgender health/);
  assert.match(expression, /gender affirming hormone therapy/);
  assert.match(expression, /cardiovascular/);
  assert.match(expression, / AND /);
});

test("focused retrieval preserves subgroup intent and excludes retraction notices", async () => {
  const client = new RetrievalClient({ skillPath: path.join(__dirname, "..", "resources", "anru") });
  try {
    await client.start();
    const surgery = await client.call("search", { query: "跨性别 手术 结局 并发症 生活质量", topK: 5 });
    assert.match(surgery.results[0].title, /surg|quality of life/i);
    assert.ok(surgery.results[0].matched_concepts >= 3);
    const hpv = await client.call("search", { query: "transgender HPV self sampling", topK: 10 });
    assert.equal(hpv.results.some((item) => /retract/i.test(item.title)), false);
  } finally {
    await client.stop();
  }
});
