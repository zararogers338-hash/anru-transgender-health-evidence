const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const { DatabaseSync } = require("node:sqlite");

test("Anru corpus keeps relational provenance and DOI-only works searchable", () => {
  const database = path.join(__dirname, "..", "resources", "anru", "data", "anru_evidence.db");
  const db = new DatabaseSync(database, { readOnly: true });
  try {
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','shadow')").all().map((row) => row.name));
    for (const required of ["journals", "works", "authors", "work_authors", "identifiers", "source_records", "crawl_runs", "works_fts"]) {
      assert.ok(tables.has(required), `missing ${required}`);
    }
    const works = Number(db.prepare("SELECT count(*) n FROM works").get().n);
    const fts = Number(db.prepare("SELECT count(*) n FROM works_fts").get().n);
    assert.equal(fts, works);
    assert.equal(Number(db.prepare("SELECT count(*) n FROM (SELECT lower(doi) FROM works WHERE doi IS NOT NULL GROUP BY lower(doi) HAVING count(*)>1)").get().n), 0);
    assert.ok(Number(db.prepare("SELECT count(*) n FROM works WHERE pmid IS NULL AND doi IS NOT NULL AND citation_url LIKE 'https://doi.org/%'").get().n) > 0);
    assert.ok(Number(db.prepare("SELECT count(*) n FROM source_records WHERE source='crossref'").get().n) > 0);
    assert.ok(Number(db.prepare("SELECT count(*) n FROM source_records WHERE source='pubmed'").get().n) > 0);
    assert.equal(Number(db.prepare("SELECT count(*) n FROM crawl_runs WHERE status!='completed'").get().n), 0);
    assert.equal(db.prepare("SELECT value FROM corpus_metadata WHERE key='release_safe'").get().value, "true");
    assert.equal(Number(db.prepare("SELECT count(*) n FROM works WHERE length(abstract)>0 AND abstract_redistributable!=1").get().n), 0);
  } finally {
    db.close();
  }
});
