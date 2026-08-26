#!/usr/bin/env python3
"""Search Anru's bundled transgender-health evidence corpus."""

from __future__ import annotations

import argparse
import json
import re
import sqlite3
from pathlib import Path
from typing import Any


STOP_WORDS = {"about", "and", "are", "for", "from", "how", "the", "what", "when", "with", "patient", "patients", "please", "study", "evidence"}
IDENTITY_TERMS = ("transgender", "transgender health", "transsexual", "nonbinary", "non-binary", "gender diverse", "gender dysphoria", "gender incongruence")
EXPANSIONS = {
    "跨性别": ("transgender", "transsexual"),
    "非二元": ("nonbinary", "non-binary", "gender diverse"),
    "性别多样": ("gender diverse",),
    "性别烦躁": ("gender dysphoria",),
    "性别不一致": ("gender incongruence",),
    "激素": ("gender affirming hormone therapy", "estrogen", "testosterone"),
    "青春期阻滞": ("puberty suppression", "puberty blocker"),
    "手术": ("gender affirming surgery",),
    "生育": ("fertility preservation", "reproductive health"),
    "心理": ("mental health", "minority stress"),
    "艾滋": ("HIV", "sexual health"),
    "肿瘤": ("cancer screening", "oncology"),
    "医疗可及": ("healthcare access", "health disparity"),
    "少数压力": ("minority stress", "discrimination"),
    "指南": ("clinical guideline", "standards of care"),
    "青少年": ("adolescent", "adolescence", "youth"),
    "未成年": ("adolescent", "youth", "minor"),
    "儿童": ("child", "pediatric", "paediatric"),
    "抑郁": ("depression", "mental health"),
    "自杀": ("suicidality", "suicide prevention"),
    "结局": ("outcome", "outcomes", "follow-up", "satisfaction"),
    "并发症": ("complication", "complications", "adverse event"),
    "生活质量": ("quality of life", "patient reported outcome", "satisfaction"),
    "心血管": ("cardiovascular", "thromboembolism", "stroke", "myocardial"),
    "风险": ("risk", "incidence", "outcome"),
    "筛查": ("screening", "early detection"),
    "农村": ("rural", "remote", "nonmetropolitan"),
    "障碍": ("barrier", "barriers", "discrimination"),
    "乳腺": ("breast", "mammography"),
    "宫颈": ("cervical", "cervix", "HPV"),
    "前列腺": ("prostate", "prostatic"),
}


def quote_fts(value: str) -> str:
    return f'"{value.replace(chr(34), chr(34) * 2)}"'


def query_plan(query: str) -> dict[str, Any]:
    lowered = query.lower()
    groups: list[list[str]] = []
    identity_keys = {"跨性别", "非二元", "性别多样", "性别烦躁", "性别不一致"}
    for key, values in EXPANSIONS.items():
        if key in lowered and key not in identity_keys:
            groups.append(list(values))
    identity_tokens = {"transgender", "transsexual", "nonbinary", "non-binary", "gender", "diverse", "dysphoria", "incongruence"}
    for token in re.findall(r"[A-Za-z][A-Za-z0-9-]{2,}", lowered):
        if token not in STOP_WORDS and token not in identity_tokens:
            groups.append([token])
    unique_groups: list[list[str]] = []
    seen: set[str] = set()
    for values in groups:
        normalized = list(dict.fromkeys(" ".join(item.split()).lower() for item in values if item.strip()))
        signature = "|".join(normalized)
        if normalized and signature not in seen:
            seen.add(signature)
            unique_groups.append(normalized)
    requested_identity = IDENTITY_TERMS
    if "非二元" in lowered or re.search(r"\bnon-?binary\b", lowered):
        requested_identity = ("nonbinary", "non-binary", "gender diverse")
    elif re.search(r"\btransmasculine\b", lowered):
        requested_identity = ("transmasculine", "transgender men")
    elif re.search(r"\btransfeminine\b", lowered):
        requested_identity = ("transfeminine", "transgender women")
    anchor = f"({' OR '.join(quote_fts(value) for value in requested_identity)})"
    clauses = [f"({' OR '.join(quote_fts(value) for value in values)})" for values in unique_groups]
    return {
        "groups": unique_groups,
        "identity_terms": requested_identity,
        "strict": f"{anchor} AND {' AND '.join(clauses)}" if clauses else anchor,
        "relaxed": f"{anchor} AND ({' OR '.join(quote_fts(value) for values in unique_groups for value in values)})" if clauses else anchor,
    }


def fts_expression(query: str) -> str:
    return str(query_plan(query)["strict"])


def evidence_level(publication_types: list[str], title: str = "") -> str:
    lowered = {item.lower() for item in publication_types}
    plain_title = re.sub(r"<[^>]*>", "", title).strip()
    if "retracted publication" in lowered or re.match(r"^retract(?:ed|ion)", plain_title, re.I):
        return "retracted"
    for source, label in (
        ("practice guideline", "guideline"), ("guideline", "guideline"),
        ("meta-analysis", "meta-analysis"), ("systematic review", "systematic-review"),
        ("randomized controlled trial", "randomized-trial"), ("clinical trial", "clinical-trial"),
        ("review", "review"),
    ):
        if source in lowered:
            return label
    if re.search(r"\bmeta[- ]analysis\b", title, re.I):
        return "meta-analysis"
    if re.search(r"\b(systematic|scoping|umbrella|integrative) review\b", title, re.I):
        return "evidence-synthesis"
    return "primary-or-other"


def abstract_excerpt(abstract: str, limit: int = 3600) -> str:
    if len(abstract) <= limit:
        return abstract
    conclusion = re.search(r"\bconclusions?\s*:", abstract, re.I)
    if conclusion and conclusion.start() > int(limit * 0.45):
        head = int(limit * 0.55)
        return f"{abstract[:head]}\n[…中间内容已省略…]\n{abstract[conclusion.start():conclusion.start() + limit - head]}"
    return f"{abstract[:limit]}…"


def run_search(db_path: Path, query: str, top_k: int = 5) -> dict[str, Any]:
    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    try:
        normalized_top_k = max(1, min(int(top_k), 20))
        plan = query_plan(query)
        candidate_limit = max(normalized_top_k * 12, 80)
        sql = """SELECT w.*, bm25(works_fts,0.0,7.0,1.0,0.2) AS rank,
                      (SELECT group_concat(DISTINCT source) FROM source_records s WHERE s.work_id=w.work_id) AS sources
               FROM works_fts JOIN works w ON w.rowid=works_fts.rowid
               WHERE works_fts MATCH ?
                 AND lower(w.publication_types) NOT LIKE '%retracted publication%'
                 AND lower(w.title) NOT LIKE 'retract%'
                 AND lower(w.title) NOT LIKE '%retraction:%'
                 AND lower(w.title) NOT LIKE '%retracted%'
               ORDER BY rank ASC,w.publication_year DESC LIMIT ?"""
        strict_rows = conn.execute(sql, (plan["strict"], candidate_limit)).fetchall()
        merged = {row["work_id"]: row for row in strict_rows}
        if len(merged) < top_k and plan["relaxed"] != plan["strict"]:
            for row in conn.execute(sql, (plan["relaxed"], candidate_limit)).fetchall():
                merged.setdefault(row["work_id"], row)

        def coverage(row: sqlite3.Row) -> tuple[int, int, int]:
            title = (row["title"] or "").lower()
            haystack = f"{title}\n{(row['abstract'] or '').lower()}"
            matched = sum(any(term in haystack for term in group) for group in plan["groups"])
            title_matches = sum(any(term in title for term in group) for group in plan["groups"])
            identity_in_title = int(any(term in title or term.replace("-", " ") in title for term in plan["identity_terms"]))
            return matched, title_matches, identity_in_title

        rows = sorted(merged.values(), key=lambda row: (-coverage(row)[0], -coverage(row)[2], -coverage(row)[1], float(row["rank"]), -(row["publication_year"] or 0)))[:normalized_top_k]
        results = []
        for index, row in enumerate(rows, 1):
            types = json.loads(row["publication_types"] or "[]")
            abstract = row["abstract"] or ""
            matched, _, _ = coverage(row)
            results.append({
                "work_id": row["work_id"], "pmid": row["pmid"], "doi": row["doi"],
                "title": row["title"], "year": row["publication_year"], "journal": row["journal"],
                "citation_url": row["citation_url"], "sources": (row["sources"] or "").split(",") if row["sources"] else [],
                "publication_types": types, "evidence_level": evidence_level(types, row["title"]),
                "result_position": index, "matched_concepts": matched, "bm25_rank": round(float(row["rank"]), 6),
                "abstract_available": bool(abstract), "abstract_redistributable": bool(row["abstract_redistributable"]),
                "license_url": row["license_url"], "retrieved_at": row["retrieved_at"],
                "abstract_excerpt": abstract_excerpt(abstract),
            })
        return {
            "query": query, "detected_topic": "transgender-health", "retrieval_mode": "fts5-bm25",
            "fts_expression": plan["strict"], "fallback_expression": plan["relaxed"] if plan["relaxed"] != plan["strict"] else None,
            "paper_count": conn.execute("SELECT count(*) FROM works").fetchone()[0],
            "results": results,
        }
    finally:
        conn.close()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("query")
    parser.add_argument("--db", type=Path, default=Path(__file__).resolve().parents[1] / "data" / "anru_evidence.db")
    parser.add_argument("--top-k", type=int, default=5)
    args = parser.parse_args()
    print(json.dumps(run_search(args.db, args.query, args.top_k), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
