# Data sources

The three publisher pages supplied for this project are source seeds, not bulk full-text endpoints.

| Journal | ISSN | Acquisition route |
| --- | --- | --- |
| Transgender Health | 2688-4887 / 2380-193X | Crossref + PubMed |
| LGBT Health | 2325-8292 / 2325-8306 | Crossref + PubMed; topic filtering required |
| International Journal of Transgender Health | 2689-5269 / 2689-5277 | Crossref + PubMed |
| International Journal of Transgenderism (former title) | 1553-2739 / 1434-4599 | Crossref + PubMed |

The builder stores source provenance and license metadata. It does not crawl restricted SAGE or Taylor & Francis article text. The bundled 0.1.0 snapshot is marked `release_safe=true`; packaging fails if any stored abstract lacks a verified redistribution flag.
