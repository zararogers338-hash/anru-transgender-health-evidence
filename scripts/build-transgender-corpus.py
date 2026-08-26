#!/usr/bin/env python3
"""Build Anru's auditable transgender-health SQLite evidence corpus.

Publisher pages are registry seeds only. Metadata is harvested through Crossref
and biomedical records through NCBI PubMed E-utilities. The builder never
downloads paywalled publisher full text.
"""

from __future__ import annotations

import argparse
import hashlib
import html
import json
import os
import re
import sqlite3
import time
import urllib.parse
import urllib.request
import urllib.error
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable


EUTILS = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils"
CROSSREF = "https://api.crossref.org"
TOPIC_QUERY = (
    '("Transgender Persons"[MeSH Terms] OR '
    '"Health Services for Transgender Persons"[MeSH Terms] OR '
    'transgender*[Title/Abstract] OR "gender diverse"[Title/Abstract] OR '
    'nonbinary[Title/Abstract] OR "non-binary"[Title/Abstract] OR '
    '"gender incongruence"[Title/Abstract] OR "gender dysphoria"[Title/Abstract])'
)
DEFAULT_REGISTRY = Path("resources/anru/references/source-registry.json")
DEFAULT_OUTPUT = Path("resources/anru/data/anru_evidence.db")


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def compact(value: str | None) -> str:
    return " ".join(str(value or "").split())


def strip_markup(value: str | None) -> str:
    raw = html.unescape(str(value or ""))
    raw = re.sub(r"<[^>]+>", " ", raw)
    return compact(raw)


def node_text(node: ET.Element | None) -> str:
    return compact("".join(node.itertext())) if node is not None else ""


def normalize_doi(value: str | None) -> str:
    doi = compact(value).lower()
    doi = re.sub(r"^(?:https?://(?:dx\.)?doi\.org/|doi:\s*)", "", doi)
    return doi.strip(" .")


def redistributable_license(url: str | None) -> bool:
    value = str(url or "").lower().rstrip("/")
    if "creativecommons.org/publicdomain/zero" in value:
        return True
    return "creativecommons.org/licenses/by/" in value and "/by-nc" not in value and "/by-nd" not in value


class HttpClient:
    def __init__(self, email: str = "", delay: float = 0.36) -> None:
        self.email = compact(email)
        self.delay = max(0.34, delay)
        contact = f"; mailto:{self.email}" if self.email else ""
        self.user_agent = f"AnruEvidenceBuilder/0.1 (local research software{contact})"

    def get(self, url: str, params: dict[str, Any] | None = None, *, post: bool = False) -> bytes:
        query = urllib.parse.urlencode(params or {}, doseq=True)
        target = url if post else f"{url}?{query}" if query else url
        request = urllib.request.Request(
            target,
            data=query.encode("utf-8") if post else None,
            headers={"User-Agent": self.user_agent, "Accept": "application/json, application/xml;q=0.9, */*;q=0.5"},
        )
        for attempt in range(6):
            try:
                with urllib.request.urlopen(request, timeout=90) as response:
                    payload = response.read()
                time.sleep(self.delay)
                return payload
            except Exception:
                if attempt == 5:
                    raise
                time.sleep(min(30, 1.5 * (2**attempt)))
        raise RuntimeError("unreachable")

    def json(self, url: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        return json.loads(self.get(url, params).decode("utf-8"))


def create_schema(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        PRAGMA journal_mode=OFF;
        PRAGMA synchronous=OFF;
        PRAGMA foreign_keys=ON;

        CREATE TABLE journals (
          journal_id INTEGER PRIMARY KEY,
          source_key TEXT NOT NULL UNIQUE,
          name TEXT NOT NULL,
          former_name TEXT,
          publisher TEXT,
          homepage TEXT NOT NULL,
          issn_print TEXT,
          issn_online TEXT,
          former_issn_print TEXT,
          former_issn_online TEXT,
          nlm_catalog TEXT
        );

        CREATE TABLE works (
          work_id TEXT PRIMARY KEY,
          doi TEXT UNIQUE COLLATE NOCASE,
          pmid TEXT UNIQUE,
          pmcid TEXT,
          openalex_id TEXT,
          title TEXT NOT NULL,
          abstract TEXT NOT NULL DEFAULT '',
          abstract_source TEXT,
          abstract_redistributable INTEGER NOT NULL DEFAULT 0,
          publication_year INTEGER,
          publication_date TEXT,
          journal_id INTEGER REFERENCES journals(journal_id),
          journal TEXT,
          issn TEXT,
          language TEXT,
          publication_types TEXT NOT NULL DEFAULT '[]',
          mesh_terms TEXT NOT NULL DEFAULT '[]',
          citation_url TEXT,
          license_url TEXT,
          is_oa INTEGER NOT NULL DEFAULT 0,
          source_updated_at TEXT,
          retrieved_at TEXT NOT NULL
        );

        CREATE TABLE authors (
          author_id INTEGER PRIMARY KEY,
          display_name TEXT NOT NULL,
          family_name TEXT,
          given_name TEXT,
          orcid TEXT,
          normalized_name TEXT NOT NULL,
          UNIQUE(normalized_name, orcid)
        );

        CREATE TABLE work_authors (
          work_id TEXT NOT NULL REFERENCES works(work_id) ON DELETE CASCADE,
          author_id INTEGER NOT NULL REFERENCES authors(author_id),
          position INTEGER NOT NULL,
          source TEXT NOT NULL,
          PRIMARY KEY(work_id, author_id, source)
        );

        CREATE TABLE identifiers (
          work_id TEXT NOT NULL REFERENCES works(work_id) ON DELETE CASCADE,
          scheme TEXT NOT NULL,
          value TEXT NOT NULL,
          PRIMARY KEY(scheme, value)
        );

        CREATE TABLE source_records (
          work_id TEXT NOT NULL REFERENCES works(work_id) ON DELETE CASCADE,
          source TEXT NOT NULL,
          source_id TEXT NOT NULL,
          source_url TEXT,
          retrieved_at TEXT NOT NULL,
          content_sha256 TEXT,
          PRIMARY KEY(source, source_id)
        );

        CREATE TABLE crawl_runs (
          run_id INTEGER PRIMARY KEY,
          source TEXT NOT NULL,
          started_at TEXT NOT NULL,
          finished_at TEXT,
          status TEXT NOT NULL,
          query TEXT,
          fetched INTEGER NOT NULL DEFAULT 0,
          inserted_or_updated INTEGER NOT NULL DEFAULT 0,
          error TEXT
        );

        CREATE VIRTUAL TABLE works_fts USING fts5(
          work_id UNINDEXED, title, abstract, journal,
          content='works', content_rowid='rowid',
          tokenize='unicode61 remove_diacritics 2'
        );

        CREATE TABLE paper_embeddings (
          work_id TEXT NOT NULL REFERENCES works(work_id) ON DELETE CASCADE,
          model_id TEXT NOT NULL,
          embedding BLOB NOT NULL,
          PRIMARY KEY(work_id, model_id)
        );

        CREATE TABLE corpus_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE INDEX works_year_idx ON works(publication_year);
        CREATE INDEX works_journal_idx ON works(journal_id);
        CREATE INDEX source_records_work_idx ON source_records(work_id);
        """
    )


def insert_registry(conn: sqlite3.Connection, registry: dict[str, Any]) -> list[dict[str, Any]]:
    journals = list(registry.get("journals") or [])
    for item in journals:
        conn.execute(
            """INSERT INTO journals(
                 source_key,name,former_name,publisher,homepage,issn_print,issn_online,
                 former_issn_print,former_issn_online,nlm_catalog
               ) VALUES(?,?,?,?,?,?,?,?,?,?)""",
            (
                item["key"], item["name"], item.get("former_name"), item.get("publisher"), item["homepage"],
                item.get("issn_print"), item.get("issn_online"), item.get("former_issn_print"),
                item.get("former_issn_online"), item.get("nlm_catalog"),
            ),
        )
    return journals


def candidate_work_id(record: dict[str, Any]) -> str:
    doi = normalize_doi(record.get("doi"))
    if doi:
        return f"doi:{doi}"
    if record.get("pmid"):
        return f"pmid:{record['pmid']}"
    source_key = f"{record.get('source')}:{record.get('source_id')}"
    return "src:" + hashlib.sha256(source_key.encode("utf-8")).hexdigest()[:32]


def resolve_existing(conn: sqlite3.Connection, record: dict[str, Any]) -> str | None:
    doi = normalize_doi(record.get("doi"))
    if doi:
        row = conn.execute("SELECT work_id FROM works WHERE doi=? COLLATE NOCASE", (doi,)).fetchone()
        if row:
            return str(row[0])
    pmid = compact(record.get("pmid"))
    if pmid:
        row = conn.execute("SELECT work_id FROM works WHERE pmid=?", (pmid,)).fetchone()
        if row:
            return str(row[0])
    return None


def journal_id_for(conn: sqlite3.Connection, record: dict[str, Any]) -> int | None:
    issn = compact(record.get("issn"))
    if issn:
        row = conn.execute(
            """SELECT journal_id FROM journals WHERE ? IN
               (issn_print,issn_online,former_issn_print,former_issn_online) LIMIT 1""",
            (issn,),
        ).fetchone()
        if row:
            return int(row[0])
    title = compact(record.get("journal")).lower()
    if title:
        row = conn.execute(
            "SELECT journal_id FROM journals WHERE lower(name)=? OR lower(former_name)=? LIMIT 1",
            (title, title),
        ).fetchone()
        if row:
            return int(row[0])
    return None


def upsert_work(conn: sqlite3.Connection, record: dict[str, Any], *, release_safe: bool) -> str:
    work_id = resolve_existing(conn, record) or candidate_work_id(record)
    doi = normalize_doi(record.get("doi")) or None
    abstract = compact(record.get("abstract"))
    abstract_ok = bool(record.get("abstract_redistributable"))
    if release_safe and not abstract_ok:
        abstract = ""
    now = utc_now()
    journal_id = journal_id_for(conn, record)
    values = {
        "work_id": work_id,
        "doi": doi,
        "pmid": compact(record.get("pmid")) or None,
        "pmcid": compact(record.get("pmcid")) or None,
        "openalex_id": compact(record.get("openalex_id")) or None,
        "title": compact(record.get("title")) or "Untitled record",
        "abstract": abstract,
        "abstract_source": compact(record.get("abstract_source")) or None,
        "abstract_redistributable": int(abstract_ok),
        "publication_year": record.get("publication_year"),
        "publication_date": compact(record.get("publication_date")) or None,
        "journal_id": journal_id,
        "journal": compact(record.get("journal")) or None,
        "issn": compact(record.get("issn")) or None,
        "language": compact(record.get("language")) or None,
        "publication_types": json.dumps(record.get("publication_types") or [], ensure_ascii=False),
        "mesh_terms": json.dumps(record.get("mesh_terms") or [], ensure_ascii=False),
        "citation_url": compact(record.get("citation_url")) or None,
        "license_url": compact(record.get("license_url")) or None,
        "is_oa": int(bool(record.get("is_oa"))),
        "source_updated_at": compact(record.get("source_updated_at")) or None,
        "retrieved_at": now,
    }
    conn.execute(
        """INSERT INTO works(
             work_id,doi,pmid,pmcid,openalex_id,title,abstract,abstract_source,
             abstract_redistributable,publication_year,publication_date,journal_id,journal,issn,
             language,publication_types,mesh_terms,citation_url,license_url,is_oa,source_updated_at,retrieved_at
           ) VALUES(
             :work_id,:doi,:pmid,:pmcid,:openalex_id,:title,:abstract,:abstract_source,
             :abstract_redistributable,:publication_year,:publication_date,:journal_id,:journal,:issn,
             :language,:publication_types,:mesh_terms,:citation_url,:license_url,:is_oa,:source_updated_at,:retrieved_at
           ) ON CONFLICT(work_id) DO UPDATE SET
             doi=COALESCE(excluded.doi,works.doi), pmid=COALESCE(excluded.pmid,works.pmid),
             pmcid=COALESCE(excluded.pmcid,works.pmcid), openalex_id=COALESCE(excluded.openalex_id,works.openalex_id),
             title=CASE WHEN length(excluded.title)>length(works.title) THEN excluded.title ELSE works.title END,
             abstract=CASE WHEN length(excluded.abstract)>length(works.abstract) THEN excluded.abstract ELSE works.abstract END,
             abstract_source=CASE WHEN length(excluded.abstract)>length(works.abstract) THEN excluded.abstract_source ELSE works.abstract_source END,
             abstract_redistributable=max(works.abstract_redistributable,excluded.abstract_redistributable),
             publication_year=COALESCE(excluded.publication_year,works.publication_year),
             publication_date=COALESCE(excluded.publication_date,works.publication_date),
             journal_id=COALESCE(excluded.journal_id,works.journal_id), journal=COALESCE(excluded.journal,works.journal),
             issn=COALESCE(excluded.issn,works.issn), language=COALESCE(excluded.language,works.language),
             publication_types=CASE WHEN excluded.publication_types!='[]' THEN excluded.publication_types ELSE works.publication_types END,
             mesh_terms=CASE WHEN excluded.mesh_terms!='[]' THEN excluded.mesh_terms ELSE works.mesh_terms END,
             citation_url=COALESCE(excluded.citation_url,works.citation_url),
             license_url=COALESCE(excluded.license_url,works.license_url), is_oa=max(works.is_oa,excluded.is_oa),
             source_updated_at=COALESCE(excluded.source_updated_at,works.source_updated_at), retrieved_at=excluded.retrieved_at""",
        values,
    )
    for scheme, value in (("doi", doi), ("pmid", values["pmid"]), ("pmcid", values["pmcid"]), ("openalex", values["openalex_id"])):
        if value:
            conn.execute("INSERT OR IGNORE INTO identifiers(work_id,scheme,value) VALUES(?,?,?)", (work_id, scheme, value))
    for position, author in enumerate(record.get("authors") or [], 1):
        display = compact(author.get("display_name"))
        if not display:
            continue
        family = compact(author.get("family_name")) or None
        given = compact(author.get("given_name")) or None
        orcid = compact(author.get("orcid")) or ""
        normalized = re.sub(r"\W+", " ", display.lower(), flags=re.UNICODE).strip()
        conn.execute(
            "INSERT OR IGNORE INTO authors(display_name,family_name,given_name,orcid,normalized_name) VALUES(?,?,?,?,?)",
            (display, family, given, orcid, normalized),
        )
        author_id = conn.execute("SELECT author_id FROM authors WHERE normalized_name=? AND orcid=?", (normalized, orcid)).fetchone()[0]
        conn.execute(
            "INSERT OR IGNORE INTO work_authors(work_id,author_id,position,source) VALUES(?,?,?,?)",
            (work_id, author_id, position, record["source"]),
        )
    source_id = compact(record.get("source_id"))
    if source_id:
        raw_hash = hashlib.sha256(json.dumps(record, ensure_ascii=False, sort_keys=True).encode("utf-8")).hexdigest()
        conn.execute(
            """INSERT OR REPLACE INTO source_records(work_id,source,source_id,source_url,retrieved_at,content_sha256)
               VALUES(?,?,?,?,?,?)""",
            (work_id, record["source"], source_id, compact(record.get("source_url")) or None, now, raw_hash),
        )
    return work_id


def date_parts(value: Any) -> tuple[str | None, int | None]:
    try:
        parts = value["date-parts"][0]
        year = int(parts[0])
        date = "-".join(str(int(part)).zfill(2 if index else 4) for index, part in enumerate(parts[:3]))
        return date, year
    except (KeyError, IndexError, TypeError, ValueError):
        return None, None


def parse_crossref(item: dict[str, Any]) -> dict[str, Any] | None:
    doi = normalize_doi(item.get("DOI"))
    title = compact(" ".join(item.get("title") or []))
    if not doi or not title:
        return None
    date, year = date_parts(item.get("published") or item.get("published-online") or item.get("issued") or {})
    licenses = item.get("license") or []
    license_url = compact(licenses[0].get("URL")) if licenses else ""
    issns = item.get("ISSN") or []
    authors = []
    for author in item.get("author") or []:
        family = compact(author.get("family"))
        given = compact(author.get("given"))
        display = compact(f"{given} {family}") or compact(author.get("name"))
        authors.append({"display_name": display, "family_name": family, "given_name": given, "orcid": author.get("ORCID", "")})
    return {
        "source": "crossref", "source_id": doi, "source_url": item.get("URL"), "doi": doi,
        "title": title, "abstract": strip_markup(item.get("abstract")), "abstract_source": "crossref",
        "abstract_redistributable": redistributable_license(license_url),
        "publication_year": year, "publication_date": date,
        "journal": compact(" ".join(item.get("container-title") or [])), "issn": issns[0] if issns else "",
        "language": item.get("language"), "publication_types": [item.get("subtype") or item.get("type") or "journal-article"],
        "citation_url": f"https://doi.org/{doi}", "license_url": license_url,
        "is_oa": bool(license_url), "source_updated_at": (item.get("indexed") or {}).get("date-time"), "authors": authors,
    }


def start_run(conn: sqlite3.Connection, source: str, query: str) -> int:
    return int(conn.execute(
        "INSERT INTO crawl_runs(source,started_at,status,query) VALUES(?,?,?,?) RETURNING run_id",
        (source, utc_now(), "running", query),
    ).fetchone()[0])


def finish_run(conn: sqlite3.Connection, run_id: int, *, status: str, fetched: int, changed: int, error: str = "") -> None:
    conn.execute(
        "UPDATE crawl_runs SET finished_at=?,status=?,fetched=?,inserted_or_updated=?,error=? WHERE run_id=?",
        (utc_now(), status, fetched, changed, compact(error)[:4000] or None, run_id),
    )
    conn.commit()


def harvest_crossref(
    conn: sqlite3.Connection, client: HttpClient, journals: list[dict[str, Any]], limit_per_journal: int, release_safe: bool
) -> tuple[int, int]:
    fetched = changed = 0
    issns: list[str] = []
    for journal in journals:
        for key in ("issn_online", "issn_print", "former_issn_online", "former_issn_print"):
            if journal.get(key) and journal[key] not in issns:
                issns.append(journal[key])
    run_id = start_run(conn, "crossref", ",".join(issns))
    try:
        for issn in issns:
            cursor = "*"
            remaining = limit_per_journal
            while remaining > 0:
                rows = min(1000, remaining)
                params: dict[str, Any] = {
                    "filter": "type:journal-article", "rows": rows, "cursor": cursor,
                }
                if client.email:
                    params["mailto"] = client.email
                try:
                    payload = client.json(f"{CROSSREF}/journals/{urllib.parse.quote(issn)}/works", params)
                except urllib.error.HTTPError as exc:
                    if exc.code == 404:
                        print(f"Crossref {issn}: no journal endpoint; skipped", flush=True)
                        break
                    raise
                message = payload.get("message") or {}
                items = message.get("items") or []
                if not items:
                    break
                for item in items:
                    fetched += 1
                    record = parse_crossref(item)
                    if record:
                        upsert_work(conn, record, release_safe=release_safe)
                        changed += 1
                conn.commit()
                remaining -= len(items)
                next_cursor = message.get("next-cursor")
                if len(items) < rows or not next_cursor or next_cursor == cursor:
                    break
                cursor = next_cursor
                print(f"Crossref {issn}: {limit_per_journal - remaining}/{limit_per_journal}", flush=True)
        finish_run(conn, run_id, status="completed", fetched=fetched, changed=changed)
        return fetched, changed
    except Exception as exc:
        finish_run(conn, run_id, status="failed", fetched=fetched, changed=changed, error=str(exc))
        raise


def pubmed_ids(client: HttpClient, query: str, retmax: int) -> list[str]:
    params = {"db": "pubmed", "term": query, "retmode": "json", "retmax": str(retmax), "sort": "pub date", "tool": "anru_evidence_builder"}
    if client.email:
        params["email"] = client.email
    result = client.json(f"{EUTILS}/esearch.fcgi", params)
    return list((result.get("esearchresult") or {}).get("idlist") or [])


def parse_pubmed_article(article: ET.Element) -> dict[str, Any] | None:
    citation = article.find("MedlineCitation")
    body = citation.find("Article") if citation is not None else None
    pmid = node_text(citation.find("PMID")) if citation is not None else ""
    title = node_text(body.find("ArticleTitle")) if body is not None else ""
    if not pmid or not title or body is None:
        return None
    abstract_parts = []
    for item in body.findall("Abstract/AbstractText"):
        value = node_text(item)
        label = item.attrib.get("Label")
        if value:
            abstract_parts.append(f"{label}: {value}" if label else value)
    journal = node_text(body.find("Journal/Title"))
    issn = node_text(body.find("Journal/ISSN"))
    date_text = " ".join([
        node_text(body.find("Journal/JournalIssue/PubDate/Year")),
        node_text(body.find("Journal/JournalIssue/PubDate/MedlineDate")),
        node_text(body.find("ArticleDate/Year")),
    ])
    year_match = re.search(r"(?:19|20)\d{2}", date_text)
    year = int(year_match.group()) if year_match else None
    publication_types = [node_text(item) for item in body.findall("PublicationTypeList/PublicationType") if node_text(item)]
    mesh_terms = [node_text(item) for item in citation.findall("MeshHeadingList/MeshHeading/DescriptorName") if node_text(item)]
    ids = {item.attrib.get("IdType", ""): node_text(item) for item in article.findall("PubmedData/ArticleIdList/ArticleId")}
    authors = []
    for author in body.findall("AuthorList/Author"):
        family = node_text(author.find("LastName"))
        given = node_text(author.find("ForeName"))
        display = compact(f"{given} {family}") or node_text(author.find("CollectiveName"))
        orcid = ""
        for ident in author.findall("Identifier"):
            if ident.attrib.get("Source", "").lower() == "orcid":
                orcid = node_text(ident)
        authors.append({"display_name": display, "family_name": family, "given_name": given, "orcid": orcid})
    doi = normalize_doi(ids.get("doi"))
    return {
        "source": "pubmed", "source_id": pmid, "source_url": f"https://pubmed.ncbi.nlm.nih.gov/{pmid}/",
        "pmid": pmid, "pmcid": ids.get("pmc", ""), "doi": doi, "title": title,
        "abstract": " ".join(abstract_parts), "abstract_source": "pubmed", "abstract_redistributable": False,
        "publication_year": year, "journal": journal, "issn": issn,
        "language": node_text(body.find("Language")), "publication_types": publication_types, "mesh_terms": mesh_terms,
        "citation_url": f"https://pubmed.ncbi.nlm.nih.gov/{pmid}/", "authors": authors,
    }


def harvest_pubmed(
    conn: sqlite3.Connection, client: HttpClient, journals: list[dict[str, Any]], retmax: int, release_safe: bool
) -> tuple[int, int]:
    issns = []
    for journal in journals:
        for key in ("issn_online", "issn_print", "former_issn_online", "former_issn_print"):
            if journal.get(key) and journal[key] not in issns:
                issns.append(journal[key])
    journal_query = " OR ".join(f'"{issn}"[ISSN]' for issn in issns)
    query = f"(({TOPIC_QUERY}) AND hasabstract[text]) OR ({journal_query})"
    run_id = start_run(conn, "pubmed", query)
    fetched = changed = 0
    try:
        ids = pubmed_ids(client, query, retmax)
        for offset in range(0, len(ids), 200):
            batch = ids[offset:offset + 200]
            params = {"db": "pubmed", "id": ",".join(batch), "retmode": "xml", "tool": "anru_evidence_builder"}
            if client.email:
                params["email"] = client.email
            payload = client.get(f"{EUTILS}/efetch.fcgi", params, post=True)
            root = ET.fromstring(payload)
            for article in root.findall("PubmedArticle"):
                fetched += 1
                record = parse_pubmed_article(article)
                if record:
                    upsert_work(conn, record, release_safe=release_safe)
                    changed += 1
            conn.commit()
            print(f"PubMed: {min(offset + len(batch), len(ids))}/{len(ids)}", flush=True)
        finish_run(conn, run_id, status="completed", fetched=fetched, changed=changed)
        return fetched, changed
    except Exception as exc:
        finish_run(conn, run_id, status="failed", fetched=fetched, changed=changed, error=str(exc))
        raise


def verify(conn: sqlite3.Connection) -> dict[str, int]:
    conn.execute("INSERT INTO works_fts(works_fts) VALUES('rebuild')")
    conn.execute("ANALYZE")
    quick = conn.execute("PRAGMA quick_check").fetchone()[0]
    if quick != "ok":
        raise RuntimeError(f"SQLite quick_check failed: {quick}")
    counts = {
        "works": int(conn.execute("SELECT count(*) FROM works").fetchone()[0]),
        "abstracts": int(conn.execute("SELECT count(*) FROM works WHERE length(abstract)>0").fetchone()[0]),
        "dois": int(conn.execute("SELECT count(*) FROM works WHERE doi IS NOT NULL").fetchone()[0]),
        "pmids": int(conn.execute("SELECT count(*) FROM works WHERE pmid IS NOT NULL").fetchone()[0]),
        "authors": int(conn.execute("SELECT count(*) FROM authors").fetchone()[0]),
        "sources": int(conn.execute("SELECT count(*) FROM source_records").fetchone()[0]),
    }
    if not counts["works"]:
        raise RuntimeError("Corpus is empty")
    return counts


def build(args: argparse.Namespace) -> dict[str, Any]:
    output = args.output.resolve()
    registry_path = args.registry.resolve()
    registry = json.loads(registry_path.read_text(encoding="utf-8"))
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_suffix(".tmp.db")
    if temporary.exists():
        temporary.unlink()
    conn = sqlite3.connect(temporary)
    try:
        create_schema(conn)
        journals = insert_registry(conn, registry)
        client = HttpClient(args.email, args.delay)
        if not args.skip_crossref:
            harvest_crossref(conn, client, journals, args.crossref_max, args.release_safe)
        if not args.skip_pubmed:
            harvest_pubmed(conn, client, journals, args.pubmed_max, args.release_safe)
        counts = verify(conn)
        metadata = {
            "name": "Anru transgender-health evidence snapshot",
            "created_at": utc_now(),
            "topic_query": TOPIC_QUERY,
            "registry_sha256": hashlib.sha256(registry_path.read_bytes()).hexdigest(),
            "release_safe": str(bool(args.release_safe)).lower(),
            **{f"count_{key}": str(value) for key, value in counts.items()},
        }
        conn.executemany("INSERT INTO corpus_metadata(key,value) VALUES(?,?)", metadata.items())
        conn.commit()
        conn.execute("VACUUM")
    finally:
        conn.close()
    temporary.replace(output)
    return {"output": str(output), "bytes": output.stat().st_size, **counts}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--registry", type=Path, default=DEFAULT_REGISTRY)
    parser.add_argument("--pubmed-max", type=int, default=3000)
    parser.add_argument("--crossref-max", type=int, default=1000, help="Maximum records per ISSN")
    parser.add_argument("--email", default=os.environ.get("ANRU_CRAWLER_EMAIL", ""))
    parser.add_argument("--delay", type=float, default=0.36)
    parser.add_argument("--skip-pubmed", action="store_true")
    parser.add_argument("--skip-crossref", action="store_true")
    parser.add_argument("--release-safe", action="store_true", help="Omit abstracts lacking a verified redistributable license")
    args = parser.parse_args()
    if not 0 <= args.pubmed_max <= 30000:
        parser.error("--pubmed-max must be between 0 and 30000")
    if not 0 <= args.crossref_max <= 10000:
        parser.error("--crossref-max must be between 0 and 10000")
    return args


if __name__ == "__main__":
    result = build(parse_args())
    print(json.dumps(result, ensure_ascii=False, indent=2))
