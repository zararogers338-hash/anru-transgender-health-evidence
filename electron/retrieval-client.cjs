const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const STOP_WORDS = new Set(["about", "and", "are", "for", "from", "how", "the", "what", "when", "with", "patient", "patients", "please", "study", "evidence"]);
const IDENTITY_TERMS = ["transgender", "transgender health", "transsexual", "nonbinary", "non-binary", "gender diverse", "gender dysphoria", "gender incongruence"];
const EXPANSIONS = {
  "跨性别": ["transgender", "transsexual"],
  "非二元": ["nonbinary", "non-binary", "gender diverse"],
  "性别多样": ["gender diverse", "gender diversity"],
  "性别烦躁": ["gender dysphoria"],
  "性别焦虑": ["gender dysphoria"],
  "性别不一致": ["gender incongruence"],
  "激素": ["gender affirming hormone therapy", "estrogen", "testosterone"],
  "青春期阻滞": ["puberty suppression", "gonadotropin releasing hormone agonist"],
  "青春期抑制": ["puberty suppression", "puberty blocker"],
  "手术": ["gender affirming surgery", "gender confirmation surgery"],
  "胸部": ["chest surgery", "mastectomy"],
  "声音": ["voice therapy", "voice surgery"],
  "生育": ["fertility preservation", "reproductive health"],
  "心理": ["mental health", "minority stress"],
  "抑郁": ["depression", "mental health"],
  "自杀": ["suicidality", "suicide prevention"],
  "艾滋": ["HIV", "sexual health"],
  "感染": ["sexually transmitted infection", "HIV"],
  "癌症": ["cancer screening", "oncology"],
  "肿瘤": ["cancer screening", "oncology"],
  "医疗可及": ["healthcare access", "health disparity"],
  "少数压力": ["minority stress", "discrimination"],
  "指南": ["clinical guideline", "standards of care"],
  "青少年": ["adolescent", "adolescence", "youth"],
  "未成年": ["adolescent", "youth", "minor"],
  "儿童": ["child", "pediatric", "paediatric"],
  "结局": ["outcome", "outcomes", "follow-up", "satisfaction"],
  "并发症": ["complication", "complications", "adverse event"],
  "生活质量": ["quality of life", "patient reported outcome", "satisfaction"],
  "心血管": ["cardiovascular", "thromboembolism", "stroke", "myocardial"],
  "风险": ["risk", "incidence", "outcome"],
  "筛查": ["screening", "early detection"],
  "农村": ["rural", "remote", "nonmetropolitan"],
  "障碍": ["barrier", "barriers", "discrimination"],
  "乳腺": ["breast", "mammography"],
  "宫颈": ["cervical", "cervix", "HPV"],
  "前列腺": ["prostate", "prostatic"],
};

function quoteFts(value) {
  return `"${value.replaceAll('"', '""')}"`;
}

function queryPlan(query) {
  const lowered = String(query || "").toLowerCase();
  const groups = [];
  for (const [term, values] of Object.entries(EXPANSIONS)) {
    if (lowered.includes(term) && !["跨性别", "非二元", "性别多样", "性别烦躁", "性别焦虑", "性别不一致"].includes(term)) groups.push(values);
  }
  const english = (lowered.match(/[a-z][a-z0-9-]{2,}/g) || []).filter((token) => !STOP_WORDS.has(token));
  const identityTokens = new Set(["transgender", "transsexual", "nonbinary", "non-binary", "gender", "diverse", "dysphoria", "incongruence"]);
  for (const token of english) if (!identityTokens.has(token)) groups.push([token]);
  const dedupedGroups = [];
  const seen = new Set();
  for (const values of groups) {
    const normalized = [...new Set(values.map((value) => value.trim().toLowerCase()).filter(Boolean))];
    const key = normalized.join("|");
    if (normalized.length && !seen.has(key)) { seen.add(key); dedupedGroups.push(normalized); }
  }
  let requestedIdentity = IDENTITY_TERMS;
  if (lowered.includes("非二元") || /\bnon-?binary\b/.test(lowered)) requestedIdentity = ["nonbinary", "non-binary", "gender diverse"];
  else if (/\btransmasculine\b/.test(lowered)) requestedIdentity = ["transmasculine", "transgender men"];
  else if (/\btransfeminine\b/.test(lowered)) requestedIdentity = ["transfeminine", "transgender women"];
  const anchor = `(${requestedIdentity.map(quoteFts).join(" OR ")})`;
  const clauses = dedupedGroups.map((values) => `(${values.map(quoteFts).join(" OR ")})`);
  return {
    groups: dedupedGroups,
    identityTerms: requestedIdentity,
    strict: clauses.length ? `${anchor} AND ${clauses.join(" AND ")}` : anchor,
    relaxed: clauses.length ? `${anchor} AND (${dedupedGroups.flat().map(quoteFts).join(" OR ")})` : anchor,
  };
}

function ftsExpression(query) {
  return queryPlan(query).strict;
}

function evidenceLevel(types, title = "") {
  const lowered = new Set(types.map((item) => String(item).toLowerCase()));
  const plainTitle = String(title).replace(/<[^>]*>/g, "").trim();
  if (lowered.has("retracted publication") || /^retract(?:ed|ion)/i.test(plainTitle)) return "retracted";
  for (const [source, label] of [["guideline", "guideline"], ["practice guideline", "guideline"], ["meta-analysis", "meta-analysis"], ["systematic review", "systematic-review"], ["randomized controlled trial", "randomized-trial"], ["clinical trial", "clinical-trial"], ["review", "review"]]) {
    if (lowered.has(source)) return label;
  }
  if (/\bmeta[- ]analysis\b/i.test(title)) return "meta-analysis";
  if (/\b(systematic|scoping|umbrella|integrative) review\b/i.test(title)) return "evidence-synthesis";
  return "primary-or-other";
}

function excerptAbstract(abstract, limit = 3600) {
  const text = String(abstract || "");
  if (text.length <= limit) return text;
  const conclusionAt = text.search(/\bconclusions?\s*:/i);
  if (conclusionAt > Math.floor(limit * 0.45)) {
    const headLength = Math.floor(limit * 0.55);
    return `${text.slice(0, headLength)}\n[…中间内容已省略…]\n${text.slice(conclusionAt, conclusionAt + limit - headLength)}`;
  }
  return `${text.slice(0, limit)}…`;
}

class RetrievalClient {
  constructor({ skillPath, onLog }) {
    this.skillPath = path.resolve(skillPath);
    this.dbPath = path.join(this.skillPath, "data", "anru_evidence.db");
    this.onLog = onLog || (() => {});
    this.db = null;
  }

  async start() {
    if (this.db) return;
    this.db = new DatabaseSync(this.dbPath, { readOnly: true });
    this.db.exec("PRAGMA query_only=ON");
    this.health();
    this.onLog("retrieval", `SQLite ready: ${this.dbPath}`);
  }

  health() {
    const papers = Number(this.db.prepare("SELECT COUNT(*) AS n FROM works").get().n);
    const abstracts = Number(this.db.prepare("SELECT COUNT(*) AS n FROM works WHERE length(abstract)>0").get().n);
    const embeddings = Number(this.db.prepare("SELECT COUNT(*) AS n FROM paper_embeddings").get().n);
    const journals = Number(this.db.prepare("SELECT COUNT(*) AS n FROM journals").get().n);
    const sourceRecords = Number(this.db.prepare("SELECT COUNT(*) AS n FROM source_records").get().n);
    return { ok: true, papers, abstracts, embeddings, journals, sourceRecords, databaseBytes: fs.statSync(this.dbPath).size, modelPresent: false, modelLoaded: false };
  }

  search(params = {}) {
    const query = String(params.query || "").trim();
    if (!query) throw new Error("Query is empty");
    const started = performance.now();
    const topK = Math.max(1, Math.min(Number(params.topK || 5), 20));
    const plan = queryPlan(query);
    const candidateLimit = Math.max(topK * 12, 80);
    const statement = this.db.prepare(`
      SELECT w.*, bm25(works_fts, 0.0, 7.0, 1.0, 0.2) AS rank,
             (SELECT group_concat(DISTINCT source) FROM source_records s WHERE s.work_id=w.work_id) AS sources
      FROM works_fts JOIN works w ON w.rowid=works_fts.rowid
      WHERE works_fts MATCH ?
        AND lower(w.publication_types) NOT LIKE '%retracted publication%'
        AND lower(w.title) NOT LIKE 'retract%'
        AND lower(w.title) NOT LIKE '%retraction:%'
        AND lower(w.title) NOT LIKE '%retracted%'
      ORDER BY rank ASC, w.publication_year DESC LIMIT ?
    `);
    const strictRows = statement.all(plan.strict, candidateLimit);
    const merged = new Map(strictRows.map((row) => [row.work_id, row]));
    if (merged.size < topK && plan.relaxed !== plan.strict) {
      for (const row of statement.all(plan.relaxed, candidateLimit)) if (!merged.has(row.work_id)) merged.set(row.work_id, row);
    }
    const coverage = (row) => {
      const title = String(row.title || "").toLowerCase();
      const haystack = `${title}\n${String(row.abstract || "").toLowerCase()}`;
      const matched = plan.groups.reduce((count, group) => count + (group.some((term) => haystack.includes(term)) ? 1 : 0), 0);
      const titleMatches = plan.groups.reduce((count, group) => count + (group.some((term) => title.includes(term)) ? 1 : 0), 0);
      const identityInTitle = plan.identityTerms.some((term) => title.includes(term.replace("-", " ")) || title.includes(term));
      return { matched, titleMatches, identityInTitle };
    };
    const rows = [...merged.values()].sort((a, b) => {
      const aCoverage = coverage(a);
      const bCoverage = coverage(b);
      return bCoverage.matched - aCoverage.matched || Number(bCoverage.identityInTitle) - Number(aCoverage.identityInTitle) || bCoverage.titleMatches - aCoverage.titleMatches || Number(a.rank) - Number(b.rank) || Number(b.publication_year || 0) - Number(a.publication_year || 0);
    }).slice(0, topK);
    const results = rows.map((row, index) => {
      let publicationTypes = [];
      try { publicationTypes = JSON.parse(row.publication_types || "[]"); } catch { publicationTypes = []; }
      const abstract = String(row.abstract || "");
      const matchedConcepts = coverage(row).matched;
      return {
        work_id: row.work_id,
        pmid: row.pmid ? String(row.pmid) : null,
        doi: row.doi || null,
        title: row.title,
        year: row.publication_year,
        journal: row.journal,
        citation_url: row.citation_url || (row.doi ? `https://doi.org/${row.doi}` : null),
        sources: String(row.sources || "").split(",").filter(Boolean),
        publication_types: publicationTypes,
        evidence_level: evidenceLevel(publicationTypes, row.title),
        result_position: index + 1,
        matched_concepts: matchedConcepts,
        bm25_rank: Number(Number(row.rank).toFixed(6)),
        abstract_available: Boolean(abstract),
        abstract_redistributable: Boolean(row.abstract_redistributable),
        license_url: row.license_url || null,
        retrieved_at: row.retrieved_at || null,
        abstract_excerpt: excerptAbstract(abstract),
      };
    });
    return {
      query,
      detected_topic: "transgender-health",
      retrieval_mode: "fts5-bm25",
      fts_expression: plan.strict,
      fallback_expression: plan.relaxed !== plan.strict ? plan.relaxed : null,
      warning: null,
      paper_count: this.health().papers,
      results,
      elapsedMs: Math.round(performance.now() - started),
      modelLoaded: false,
    };
  }

  async call(method, params = {}) {
    if (!this.db) throw new Error("检索服务未启动");
    if (method === "health") return this.health();
    if (method === "search") return this.search(params);
    throw new Error(`Unknown retrieval method: ${method}`);
  }

  async stop() {
    this.db?.close();
    this.db = null;
  }
}

module.exports = { RetrievalClient, evidenceLevel, excerptAbstract, ftsExpression, queryPlan };
