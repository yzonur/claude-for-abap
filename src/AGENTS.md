# src/ — server core

## Purpose

Everything the MCP server needs before a request reaches a tool handler: process entry point, SAP session/connection handling, ADT client (HTTP calls to the ADT REST API), config loading, locking, source diffing, and crash reporting.

## Ownership

Root DOX applies. This folder is the shared substrate every tool in `src/tools/` depends on — changes here are wide-blast-radius.

## Local Contracts

- `server.js` is the process entry point and the only file wired into `package.json`'s `bin`/`main`. Keep it thin — routing to `src/tools/*`, not business logic.
- `config.js` owns config resolution (`~/.sap-adt-mcp/config.json`, `SAP_ADT_MCP_CONFIG` env, multi-system `systems` map, per-system `readOnly`). Any new config key must have a documented default and be covered by `test/config.test.js`.
- `adt-client.js` owns the actual HTTP calls to SAP and the `READONLY_POST_PATHS` allowlist (POST-shaped ADT calls that are semantically read-only, e.g. search, where-used). Adding a tool that POSTs but doesn't write SAP state means adding its path here — not routing around `readOnly`.
- `adt-error.js` parses the ADT XML error envelope into structured JSON; every tool should surface errors through it (`errorResult(...)`) rather than raw HTTP failures.
- `data-preview.js` (backs `adt_read_table`) is SELECT-only by construction — this is enforced here, both in query parsing and before the request is sent. Do not weaken this to add write support; that's explicitly out of scope for the project.
- `audit.js` is the local write-audit log (JSONL, opt-out via `audit.enabled=false` or `SAP_ADT_MCP_AUDIT=0`). Any new code path that performs a write (POST/PUT/DELETE/PATCH beyond `READONLY_POST_PATHS`) must go through the audited request path, not a bypass.
- `reporter.js` is the privacy-preserving crash reporter (paired with `worker/reporter.worker.js`). It must never include SAP host, credentials, or business data in a report payload.

## Work Guidance

- Prefer extending an existing module (`object-uris.js` for type aliases, `object-references.js`/`node-structure.js` for object-tree shapes) over introducing a new one for a one-off need.
- Any change to timeout/retry defaults in `adt-client.js` needs a CONTRIBUTING.md-style discussion first (documented in root AGENTS.md Local Contracts) — it changes behavior for every existing agent.

## Verification

- `npm test` covers this folder via the per-module tests in `test/` (e.g. `adt-error.test.js`, `config.test.js`, `data-preview.test.js`, `lock.test.js`, `diff.test.js`, `reporter.test.js`, `security.test.js`).
- `npm run lint`.

## Child DOX Index

- `src/tools/AGENTS.md` — the MCP tool handlers that sit on top of this infrastructure
