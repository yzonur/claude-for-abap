# DOX framework

- DOX is a lightweight AGENTS.md hierarchy installed in this repository
- Agent must follow DOX instructions across any edits

## Core Contract

- AGENTS.md files are binding work contracts for their subtrees
- Work products, source materials, instructions, records, assets, and durable docs must stay understandable from the nearest applicable AGENTS.md plus every parent AGENTS.md above it

## Read Before Editing

1. Read this root AGENTS.md
2. Identify every file or folder you expect to touch
3. Walk from the repository root to each target path
4. Read every AGENTS.md found along each route
5. If a parent AGENTS.md lists a child AGENTS.md whose scope contains the path, read that child and continue from there
6. Use the nearest AGENTS.md as the local contract and parent docs for repo-wide rules
7. If docs conflict, the closer doc controls local work details, but no child doc may weaken DOX

Do not rely on memory. Re-read the applicable DOX chain in the current session before editing.

## Update After Editing

Every meaningful change requires a DOX pass before the task is done.

Update the closest owning AGENTS.md when a change affects:

- purpose, scope, ownership, or responsibilities
- durable structure, contracts, workflows, or operating rules
- required inputs, outputs, permissions, constraints, side effects, or artifacts
- user preferences about behavior, communication, process, organization, or quality
- AGENTS.md creation, deletion, move, rename, or index contents

Update parent docs when parent-level structure, ownership, workflow, or child index changes. Update child docs when parent changes alter local rules. Remove stale or contradictory text immediately. Small edits that do not change behavior or contracts may leave docs unchanged, but the DOX pass still must happen.

## Purpose

sap-adt-mcp is an MCP server that gives an AI agent live access to SAP systems via the ADT (ABAP Development Tools) REST API: read source, search objects, run syntax checks, read tables (SELECT-only), debug, manage transports, and edit ABAP objects when `readOnly` is off.

## Ownership

Maintained by the project author (see `package.json` `author`/`repository`). Contributions go through PRs per `CONTRIBUTING.md`.

## Local Contracts

- Pure JavaScript, ESM, Node >=22.19. No TypeScript build step.
- All source comments in English.
- Runtime deps are deliberately minimal (`@modelcontextprotocol/sdk`, `undici`); do not add a new one without discussion.
- `npm run lint && npm test` must pass before any change is considered done.
- Every tool must behave correctly under `readOnly` mode (see `src/config.js`); a tool that only performs read-only POSTs (search, where-used, etc.) belongs in `READONLY_POST_PATHS` in `src/adt-client.js`, never bypassed.
- `adt_read_table` (`src/data-preview.js`) is SELECT-only by construction, both client- and server-side — this is a security rail, not a config toggle. Do not add a path that lets it write.
- Out of scope for this repo (per `CONTRIBUTING.md`): arbitrary RFC calls, generic writable table access against business data, ABAP debugger changes beyond the existing tool set, ADT mock servers.

## Work Guidance

- When adding a new high-level tool: keep the input schema flat and small, reuse the friendly type aliases in `src/object-uris.js` instead of raw TADIR codes, wrap errors via `errorResult(...)` so the ADT XML error envelope parses correctly, decide and document its `readOnly` behavior, and document it in `README.md` (table + example prompt) and `CHANGELOG.md`.
- Bug fixes need a regression test under `test/`, mirroring the module name being fixed (e.g. a fix in `src/lock.js` gets a test in `test/lock.test.js`).
- Schema changes to existing tools and any change to network defaults (timeouts, retries) require an issue/discussion first — they can break downstream agents already relying on the current shape.

## Verification

- `npm test` — runs the full suite listed in `package.json`'s `test` script (per-module `node --test` files under `test/`). No SAP connection required.
- `npm run lint` — ESLint over `src` and `test`.
- End-to-end testing against a real SAP system needs a local `~/.sap-adt-mcp/config.json` (see `config.example.json`); never commit a real config or credentials (`.gitignore` already excludes `config.json` and `.env` — keep it that way).

## Style

- Keep docs concise, current, and operational
- Document stable contracts, not diary entries
- Put broad rules in parent docs and concrete details in child docs
- Prefer direct bullets with explicit names
- Do not duplicate rules across many files unless each scope needs a local version
- Delete stale notes instead of explaining history
- Trim obvious statements, repeated rules, misplaced detail, and warnings for risks that no longer exist

## Closeout

1. Re-check changed paths against the DOX chain
2. Update nearest owning docs and any affected parents or children
3. Refresh every affected Child DOX Index
4. Remove stale or contradictory text
5. Run `npm run lint && npm test`
6. Report any docs intentionally left unchanged and why

## User Preferences

(none recorded yet — add durable behavior requests here as they come up)

## Child DOX Index

- `src/AGENTS.md` — server entry point, ADT client/session plumbing, and shared infrastructure (config, locking, diffing, reporting)
- `src/tools/AGENTS.md` — the MCP tool handlers themselves, grouped by domain (discovery, source, lifecycle, debug, quality, RAP, jobs, transports, ...)
- `skills/AGENTS.md` — packaged, npm-shipped skills (each with its own prerequisites and read-only/write posture)
- Not yet covered by a child doc (root rules apply): `test/`, `worker/`, `scripts/`, `examples/`
