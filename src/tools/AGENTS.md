# src/tools/ — MCP tool handlers

## Purpose

Each file here implements one domain's worth of MCP tools exposed to the agent (discovery/search, source read-write, lifecycle/activation, debugging, quality checks, RAP scaffolding, background jobs, transports, cross-system calls, generic ADT requests).

## Ownership

Parent: `src/AGENTS.md`. This is the most actively extended part of the codebase — new SAP capability almost always lands as a new tool here or a new function in an existing domain file.

## Local Contracts

This is where `CONTRIBUTING.md`'s "Tool design checklist" applies directly:

1. Keep the input schema flat and small; use the friendly type aliases from `src/object-uris.js` rather than raw TADIR object-type codes.
2. Wrap every error via `errorResult(...)` (from `src/adt-error.js`) so the ADT XML error envelope is parsed into structured JSON instead of leaking raw HTTP failures.
3. Decide the tool's `readOnly` behavior explicitly. If it writes SAP state, it must be blocked (or gated) when the target system's `readOnly` is true. If its endpoint is a "read-only POST" (search, where-used, etc.), register it in `READONLY_POST_PATHS` (`src/adt-client.js`) instead of leaving it ambiguous.
4. Document the tool in `README.md` (table + example prompt) and add a `CHANGELOG.md` entry.
5. If the endpoint's shape varies across NetWeaver/S/4 releases, say so in the tool's description string so the agent knows when to fall back to `adt_request`.

Out of scope here (per root AGENTS.md / `CONTRIBUTING.md`): arbitrary/generic RFC or function-module invocation, generic writable business-table access, new ABAP debugger surface beyond `debug.js`'s existing tool set.

## Work Guidance

- One domain per file (`discovery.js`, `source.js`, `lifecycle.js`, `debug.js`, `quality.js`, `rap.js`, `jobs.js`, `transports.js`, `cross-system.js`, `notes.js`, `versions.js`, `worklist.js`, `panel.js`, `report.js`, `request.js`, `data.js`, `cds.js`, `runtime.js`). Add a new domain file only when an existing one doesn't fit; otherwise extend the closest match.
- `_shared.js` holds cross-tool helpers — put something here only if at least two domain files need it.
- `connection.js` is the multi-system dispatch layer (resolves the `system` parameter every tool accepts against `src/config.js`'s `systems` map). A tool that skips this and hardcodes the default system is a bug.

## Verification

- Each domain file should have a matching `test/<domain>.test.js`. `test/tools-shape.test.js` checks the overall tool schema shape — run it after adding or changing any tool's input schema.
- `npm run lint && npm test` before considering a new tool done.

## Child DOX Index

- No child AGENTS.md files needed at this level; all tool files share the contracts above.
