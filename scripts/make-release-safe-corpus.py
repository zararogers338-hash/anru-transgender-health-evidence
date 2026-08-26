#!/usr/bin/env python3
"""Create a redistribution-safe Anru corpus from a development snapshot."""

from __future__ import annotations

import argparse
import hashlib
import shutil
import sqlite3
from datetime import datetime, timezone
from pathlib import Path


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def sanitize(source: Path, output: Path) -> None:
    source = source.resolve()
    output = output.resolve()
    if source == output:
        raise ValueError("Source and output must be different paths")
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_suffix(f"{output.suffix}.tmp")
    if temporary.exists():
        temporary.unlink()
    shutil.copy2(source, temporary)
    source_hash = sha256(source)
    conn = sqlite3.connect(temporary)
    try:
        conn.execute("PRAGMA foreign_keys=ON")
        conn.execute("BEGIN IMMEDIATE")
        conn.execute("UPDATE works SET abstract='', abstract_source=NULL WHERE abstract_redistributable!=1")
        conn.execute("INSERT OR REPLACE INTO corpus_metadata(key,value) VALUES('release_safe','true')")
        conn.execute("INSERT OR REPLACE INTO corpus_metadata(key,value) VALUES('sanitized_at',?)", (datetime.now(timezone.utc).isoformat(),))
        conn.execute("INSERT OR REPLACE INTO corpus_metadata(key,value) VALUES('sanitized_from_sha256',?)", (source_hash,))
        abstracts = conn.execute("SELECT count(*) FROM works WHERE length(abstract)>0").fetchone()[0]
        conn.execute("INSERT OR REPLACE INTO corpus_metadata(key,value) VALUES('count_abstracts',?)", (str(abstracts),))
        conn.execute("INSERT INTO works_fts(works_fts) VALUES('rebuild')")
        conn.commit()
        unsafe = conn.execute("SELECT count(*) FROM works WHERE length(abstract)>0 AND abstract_redistributable!=1").fetchone()[0]
        integrity = conn.execute("PRAGMA quick_check").fetchone()[0]
        if unsafe or integrity != "ok":
            raise RuntimeError(f"Release corpus validation failed: unsafe={unsafe}, quick_check={integrity}")
        conn.execute("VACUUM")
    finally:
        conn.close()
    temporary.replace(output)
    print(f"release_safe=true works={sqlite_count(output, 'works')} abstracts={sqlite_abstracts(output)} sha256={sha256(output)}")


def sqlite_count(database: Path, table: str) -> int:
    conn = sqlite3.connect(f"file:{database}?mode=ro", uri=True)
    try:
        return int(conn.execute(f"SELECT count(*) FROM {table}").fetchone()[0])
    finally:
        conn.close()


def sqlite_abstracts(database: Path) -> int:
    conn = sqlite3.connect(f"file:{database}?mode=ro", uri=True)
    try:
        return int(conn.execute("SELECT count(*) FROM works WHERE length(abstract)>0").fetchone()[0])
    finally:
        conn.close()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    sanitize(args.source, args.output)


if __name__ == "__main__":
    main()
