# Anru 0.1.0 release audit

Audit date: 2026-08-26 (Asia/Tokyo)

## Verdict

The Windows x64 package is ready for an unsigned research preview. The installer, installed application, bundled database and UI were exercised from the final release payload. It is not a regulated medical device and is not code-signed.

## Build and runtime

- `npm test`: 24 passed, 0 failed.
- `npm audit --omit=dev --audit-level=high`: 0 known vulnerabilities.
- Vite production build and Electron x64 directory build completed.
- Custom black Anru installer completed; silent install to a new directory returned exit code 0.
- The installed `Anru.exe` started from the installed directory and produced both light- and dark-theme capture images.
- Installed manifest hashes matched the installed executable and SQLite database.
- Runtime dependencies are bundled. End users do not need Node.js, Python, 7-Zip or a separate browser runtime.

## Corpus

- SQLite `quick_check`: `ok`; foreign-key errors: 0.
- Works / FTS5 rows: 9,873 / 9,873.
- DOI / PMID: 9,806 / 7,964.
- Authors / source records: 43,585 / 10,451.
- Stored abstracts: 161; explicitly redistributable abstracts: 161; unsafe stored abstracts: 0.
- `corpus_metadata.release_safe`: `true`.
- Direct restricted publisher full text is not included.
- Default retrieval excludes retracted publications/notices, preserves a transgender or gender-diverse population anchor, groups bilingual concepts with AND logic, and records rank, provenance, license and retrieval date.

## Security and privacy

- Renderer runs with sandboxing, context isolation and no Node integration.
- IPC handlers validate the calling renderer; packaged builds ignore `VITE_DEV_SERVER_URL`.
- Web tools reject local, private, reserved and IPv4-mapped IPv6 destinations and recheck redirects.
- File access rejects traversal, credential locations and junction/symlink escapes; state-changing computer operations require one-time UI approval.
- API keys remain in the main process and use Electron `safeStorage` on Windows.
- Chat history is encrypted at rest. Unreadable history is copied to a timestamped recovery backup before a new store can replace it.
- Attachments are size/type bounded, parsed locally and treated as untrusted content.
- Source scan found no embedded production API key and no Ayin/Alzheimer/ACL branding residue.

## UI and accessibility

- Anru uses a distinct editorial archive composition: black journal ledger, warm paper workspace, vertical research cards and horizontal evidence workflow—not Ayin's illustrated split canvas.
- Full navigation remains reachable on narrow screens.
- Chinese IME composition does not trigger submission.
- Streaming output follows only while the reader remains near the bottom; a `LATEST` control restores following.
- Inputs have accessible names and visible focus containers; command and computer-approval dialogs trap and restore keyboard focus, support Escape, and inert the background.
- Light and dark themes were captured from the installed build.

## Final artifact hashes

- Installer SHA-256: `a6fdc7e7d29633a43034e458beaf437e985ddf51eae1b7e781658652dab78249`
- Bundled database SHA-256: `3b6eb4708974ef84f2b22800f29f7c63a03a3f4a5fdde8615c601424c40b8e99`

## Known limitations

- The installer and application are unsigned; reputation warnings are expected until a signing certificate is used.
- Retrieval is deterministic SQLite FTS5/BM25 with bilingual query planning. The schema reserves embeddings, but BGE-M3 weights and vectors are not included in this release.
- Most records are metadata-only in the public package. The agent should open the DOI/PubMed/official source when full-text or exact-effect verification is needed.
- The product only connects to a user-configured third-party model. Provider availability, privacy policy, pricing and model behavior remain external dependencies.
