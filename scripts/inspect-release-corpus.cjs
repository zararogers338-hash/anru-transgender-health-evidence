#!/usr/bin/env node
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const database = path.resolve(String(process.argv[2] || ""));
if (!database) throw new Error("Database path is required");
const db = new DatabaseSync(database, { readOnly: true });
try {
  const scalar = (sql) => Number(db.prepare(sql).get().n);
  const releaseSafe = db.prepare("SELECT value FROM corpus_metadata WHERE key='release_safe'").get()?.value === "true";
  process.stdout.write(JSON.stringify({
    papers: scalar("SELECT count(*) n FROM works"),
    abstracts: scalar("SELECT count(*) n FROM works WHERE length(abstract)>0"),
    redistributableAbstracts: scalar("SELECT count(*) n FROM works WHERE length(abstract)>0 AND abstract_redistributable=1"),
    unsafeAbstracts: scalar("SELECT count(*) n FROM works WHERE length(abstract)>0 AND abstract_redistributable!=1"),
    sources: scalar("SELECT count(*) n FROM source_records"),
    releaseSafe,
  }));
} finally {
  db.close();
}
