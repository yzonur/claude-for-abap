# skills/ — packaged agent skills

## Purpose

Each subfolder is one skill shipped inside the npm package (`package.json` `files` includes `skills`), giving an agent a structured workflow on top of the raw MCP tools (e.g. `abap-clean-core`, `dump-triage`, `legacy-code-doc`, `transport-release-gate`).

## Ownership

Parent: root `AGENTS.md`. New skills are a welcome contribution per `CONTRIBUTING.md` ("Documentation, example prompts, troubleshooting tips").

## Local Contracts

- One skill = one folder = one `SKILL.md` with YAML frontmatter: `name` (matches the folder name) and `description` (states exactly when to use it, ends with its read-only/write posture — e.g. "Fully read-only — safe on production.").
- Every `SKILL.md` must have a **Prerequisites** section stating: minimum `sap-adt-mcp` version, minimum NetWeaver/S/4 release for the ADT endpoints it uses, required SAP user authorizations, and explicit `readOnly`-mode compatibility.
- A skill that only reads (search, source, where-used, versions, read-only `adt_read_table` samples) should say so plainly and never silently depend on a write-capable tool.
- A skill that writes (activates objects, creates transports, etc.) must call that out prominently in the frontmatter `description`, not bury it in the body.

## Work Guidance

- Model new skills on `legacy-code-doc/SKILL.md`: a numbered **Workflow** section the agent can follow step by step, not prose the agent has to infer structure from.
- Keep a skill scoped to one job. If a workflow branches into two genuinely different use cases, prefer two skills over one with a large conditional.
- Cross-reference other skills by name when a workflow's output feeds another (e.g. `legacy-code-doc`'s migration-notes section pointing at `abap-clean-core`) instead of duplicating their content.

## Verification

- No automated test suite covers skill content directly; verification is manual — walk the skill's workflow against a real (or read-only) system before proposing it in a PR.
- Root-level `npm run lint && npm test` still applies to any code changes a skill's PR bundles alongside it.

## Child DOX Index

- No child AGENTS.md files per individual skill folder; the contracts above apply uniformly. Add a per-skill AGENTS.md only if a specific skill grows local tooling (scripts, fixtures) that needs its own rules.
