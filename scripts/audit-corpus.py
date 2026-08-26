#!/usr/bin/env python3
"""Audit Anru's bundled SQLite corpus and emit a machine-readable report."""

from __future__ import annotations

import argparse
import json
import sqlite3
from pathlib import Path


def scalar(conn: sqlite3.Connection, query: str) -> int:
    return int(conn.execute(query).fetchone()[0])


def audit(database: Path, require_release_safe: bool = False) -> dict:
    conn = sqlite3.connect(f"file:{database.resolve()}?mode=ro", uri=True)
    try:
        quick_check = conn.execute("PRAGMA quick_check").fetchone()[0]
        foreign_key_errors = len(conn.execute("PRAGMA foreign_key_check").fetchall())
        metadata = {row[0]: row[1] for row in conn.execute("SELECT key,value FROM corpus_metadata")}
        report = {
            "database": str(database.resolve()),
            "bytes": database.stat().st_size,
            "quick_check": quick_check,
            "foreign_key_errors": foreign_key_errors,
            "works": scalar(conn, "SELECT count(*) FROM works"),
            "abstracts": scalar(conn, "SELECT count(*) FROM works WHERE length(abstract)>0"),
            "redistributable_abstracts": scalar(conn, "SELECT count(*) FROM works WHERE length(abstract)>0 AND abstract_redistributable=1"),
            "unsafe_stored_abstracts": scalar(conn, "SELECT count(*) FROM works WHERE length(abstract)>0 AND abstract_redistributable!=1"),
            "release_safe": metadata.get("release_safe") == "true",
            "dois": scalar(conn, "SELECT count(*) FROM works WHERE doi IS NOT NULL"),
            "pmids": scalar(conn, "SELECT count(*) FROM works WHERE pmid IS NOT NULL"),
            "authors": scalar(conn, "SELECT count(*) FROM authors"),
            "source_records": scalar(conn, "SELECT count(*) FROM source_records"),
            "fts_rows": scalar(conn, "SELECT count(*) FROM works_fts"),
            "duplicate_dois": scalar(conn, "SELECT count(*) FROM (SELECT lower(doi) FROM works WHERE doi IS NOT NULL GROUP BY lower(doi) HAVING count(*)>1)"),
            "empty_titles": scalar(conn, "SELECT count(*) FROM works WHERE length(trim(title))=0"),
            "failed_runs": scalar(conn, "SELECT count(*) FROM crawl_runs WHERE status!='completed'"),
            "sources": {row[0]: int(row[1]) for row in conn.execute("SELECT source,count(*) FROM source_records GROUP BY source ORDER BY source")},
            "journals": {row[0]: int(row[1]) for row in conn.execute("SELECT coalesce(j.name,w.journal,'Unknown'),count(*) FROM works w LEFT JOIN journals j ON j.journal_id=w.journal_id GROUP BY coalesce(j.name,w.journal,'Unknown') ORDER BY count(*) DESC LIMIT 20")},
        }
        report["ok"] = all([
            quick_check == "ok", foreign_key_errors == 0, report["works"] > 0,
            report["fts_rows"] == report["works"], report["duplicate_dois"] == 0,
            report["empty_titles"] == 0, report["failed_runs"] == 0,
            not require_release_safe or (report["release_safe"] and report["unsafe_stored_abstracts"] == 0),
        ])
        return report
    finally:
        conn.close()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("database", nargs="?", type=Path, default=Path("resources/anru/data/anru_evidence.db"))
    parser.add_argument("--require-release-safe", action="store_true")
    args = parser.parse_args()
    report = audit(args.database, require_release_safe=args.require_release_safe)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    if not report["ok"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
