# sap-adt-mcp

> **MCP server giving Claude (and any MCP-compatible client) live access to SAP systems via ADT.**
>
> Read source, search the repository, run syntax checks, run unit tests, run
> ATC, diff the same object across landscapes, edit and activate ABAP — all
> from a chat window or an autonomous agent. No add-on installation on the SAP
> stack required.

[![npm version](https://img.shields.io/npm/v/sap-adt-mcp.svg)](https://www.npmjs.com/package/sap-adt-mcp)
[![CI](https://github.com/yzonur/sap-adt-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/yzonur/sap-adt-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/node/v/sap-adt-mcp.svg)](https://nodejs.org)

---

## Why

SAP development is full of repetitive read-the-source / check-the-callers /
diff-the-system work. AI assistants are great at exactly that kind of task —
but only if they can reach the system. ADT (ABAP Development Tools) is the
HTTP API that Eclipse uses; it ships with every modern NetWeaver and S/4
system. This server speaks ADT on behalf of the agent so the agent can do real
work against your real systems, with the same auth and scoping you'd give a
developer in Eclipse.

## What's in the box

**27 high-level tools** wrapped around the most common ADT endpoints, plus a
generic escape hatch for anything else, **plus 5 user-invokable Clean Core
prompts** that turn the tool surface into outcome-shaped slash commands
(see [Clean Core prompts](#clean-core-prompts) below).

| Category | Tools |
| --- | --- |
| Connection | `adt_list_systems`, `adt_ping` |
| Source CRUD | `adt_get_source`, `adt_set_source` |
| Quality | `adt_syntax_check`, `adt_pretty_print`, `adt_run_unit_tests`, `adt_run_atc`, `adt_run_atc_package`, `adt_run_atc_transport` |
| Lifecycle | `adt_create_object`, `adt_delete_object`, `adt_activate`, `adt_lock`, `adt_unlock`, `adt_list_inactive_objects` |
| Versions | `adt_list_versions`, `adt_compare_versions` |
| Discovery | `adt_browse_package`, `adt_list_packages`, `adt_search_objects`, `adt_grep_source`, `adt_where_used` |
| CDS | `adt_cds_data_preview`, `adt_cds_dependencies`, `adt_list_released_apis` |
| Cross-system | `adt_compare_source`, `adt_transport_diff` |
| Transports | `adt_list_transports`, `adt_get_transport`, `adt_create_transport`, `adt_release_transport` |
| Runtime errors | `adt_list_dumps`, `adt_get_dump` |
| Debugger | `adt_debug_set_breakpoint`, `adt_debug_delete_breakpoint`, `adt_debug_listen`, `adt_debug_stack`, `adt_debug_variables`, `adt_debug_step`, `adt_debug_goto_stack`, `adt_debug_set_variable`, `adt_debug_set_watchpoint`, `adt_debug_delete_watchpoint`, `adt_debug_stop` |
| Data | `adt_read_table` |
| Generation | `adt_rap_scaffold` |
| Experimental¹ | `adt_get_note`, `adt_check_note_status`, `adt_implement_note`, `adt_list_locks`, `adt_schedule_job`, `adt_read_spool` |
| Escape hatch | `adt_request` |

¹ Experimental tools target ADT endpoints (SNOTE, SM12 enqueues, SM36/SP01)
that classic NetWeaver does not expose; on such systems they return
`available:false` with a fall-back hint rather than failing. They work where the
backing service exists (typically S/4HANA).

**Multi-system aware.** One config, many SAP systems (DEV / QAS / PRD or
landscape-wide); switch with the `system` argument or compare across two with
`adt_compare_source` / `adt_transport_diff`.

**Safe by default.** A `readOnly` flag (global or per-system) blocks every
write method. Read-only POST queries (search, where-used, package tree)
remain allowed so agents can still discover.

**Robust.** Per-request timeout. CSRF token negotiation with auto-retry on
403. Self-signed cert opt-out. Optional debug tracing to stderr.

**Structured errors.** ADT's `<exc:exception>` envelopes are parsed into
`{ type, message, namespace }` so failed calls don't dump XML into the agent's
context window.

## Install

> Previously published as `claude-for-abap` — that package still works but is
> deprecated; new installs should use `sap-adt-mcp`.

```bash
# global
npm install -g sap-adt-mcp

# or run without installing
npx sap-adt-mcp
```

Requires Node.js **22.19+** (undici v8, used as the HTTP client, requires
this minimum).

## Configure

Create your config:

```bash
mkdir -p ~/.sap-adt-mcp
cp config.example.json ~/.sap-adt-mcp/config.json
$EDITOR ~/.sap-adt-mcp/config.json
```

The server searches in this order:

1. `$SAP_ADT_MCP_CONFIG` (absolute path)
2. `~/.sap-adt-mcp/config.json`
3. `./config.json` (cwd at server start)

### Sample config

```json
{
  "defaultSystem": "DEV",
  "readOnly": false,
  "systems": {
    "DEV": {
      "host": "https://sap-dev.example.com:44300",
      "client": "100",
      "language": "EN",
      "user": "DEVELOPER",
      "password": "env:SAP_DEV_PASSWORD",
      "rejectUnauthorized": false
    },
    "QAS": {
      "host": "https://sap-qas.example.com:44300",
      "client": "200",
      "user": "DEVELOPER",
      "password": "env:SAP_QAS_PASSWORD"
    },
    "PRD": {
      "host": "https://sap-prd.example.com:44300",
      "client": "300",
      "user": "READONLY",
      "password": "env:SAP_PRD_PASSWORD",
      "readOnly": true
    }
  }
}
```

### Per-system options

| Field | Meaning |
| --- | --- |
| `host` | Base URL including scheme + ICM HTTPS port (e.g. `https://...:44300`). |
| `client` | SAP client (sets `sap-client` query param). |
| `language` | Optional logon language (sets `sap-language`). |
| `user` | RFC user. |
| `password` | Either a literal string or `env:VAR_NAME` to read from environment. |
| `rejectUnauthorized` | Set `false` to skip TLS validation for self-signed certs. Default `true`. |
| `readOnly` | Block POST / PUT / DELETE / PATCH for this system (read-only POST queries still work). |
| `timeoutMs` | Override default 30 s request timeout. |

### Read-only mode

`readOnly: true` (top-level or per-system) refuses any unsafe HTTP method.
Whitelisted read-only POST endpoints (`nodestructure`, `search`,
`usagereferences`, `parsers`, `checkruns`) remain available so agents can
still discover and analyze without being able to modify.

Recommended: set `readOnly: true` for QAS and PRD profiles. Keep DEV writable.

### Self-signed certificates

Many internal SAP systems use self-signed certs. `"rejectUnauthorized": false`
disables TLS validation for that profile only. Don't set this on PRD.

### Audit log

Every **write** the server performs against SAP (POST/PUT/DELETE/PATCH — locks,
source updates, activations, transport operations) is appended to a local JSONL
file, including which MCP tool triggered it and, for blocked attempts in
read-only mode, the violation itself. Reads and read-only queries are not
logged. Nothing leaves your machine — this is your local answer to "what exactly
did the AI change?".

Default location: `~/.sap-adt-mcp/audit.log`. One JSON object per line:

```json
{"ts":"2026-06-11T12:00:00.000Z","tool":"adt_set_source","host":"https://...","sapUser":"DEVELOPER","method":"PUT","path":"/sap/bc/adt/programs/programs/ztest/source/main","status":200,"ok":true,"transport":"E4DK900123"}
```

Configure or disable:

```json
{ "audit": { "enabled": false, "path": "/var/log/sap-adt-mcp/audit.log" } }
```

…or set `SAP_ADT_MCP_AUDIT=0` (also accepts `false`/`no`/`off`).

### Automatic error reporting

The server sends small, **redacted** reports to the maintainer so defects get
found and fixed. This is **on by default** and the server prints a notice saying
so on startup. There are three channels:

1. **Crash** — a tool handler throws an unexpected error.
2. **ADT error** — a tool returns a non-2xx ADT response that the classifier
   flags as a likely tool bug (406/415 content negotiation, malformed requests,
   server dispatcher blow-ups). User/business-side responses (401/403/404, lock
   and enqueue conflicts, data-preview SQL errors) are **not** reported.
3. **Agent-reported** — the calling agent files a defect the other two channels
   can't see (wrong data in a successful response, an ignored parameter, a
   missing capability) via the **`adt_report_issue`** tool.

What is sent: the sap-adt-mcp version, Node version, OS, the tool name, and the
error/finding with a fingerprint for de-duplication, plus an **anonymous install
id** (random bytes, cached at `~/.sap-adt-mcp/install-id`) that lets repeat
reports from the same install be grouped for triage — it identifies neither you
nor your system. Before anything leaves your machine it is scrubbed of
**hostnames, users, passwords, tokens, IPs, and emails**; tool arguments and
free-text fields are redacted the same way. Reports
go to a relay the maintainer owns, which files/de-dups a GitHub issue — the
relay holds the GitHub credentials, never this package.

Turn it all off:

```json
{ "reporting": { "enabled": false } }
```

…or set `SAP_ADT_MCP_REPORT=0` (also accepts `false`/`no`/`off`). Finer control:

| Key | Default | Effect |
| --- | --- | --- |
| `reporting.enabled` | `true` | Master switch for all three channels. |
| `reporting.adtErrors` | `true` | Channel 2 (auto-report flagged ADT errors). |
| `reporting.allowManual` | `true` | Channel 3 (the `adt_report_issue` tool). |
| `reporting.includeArgs` | `true` | Include redacted tool args / repro args. Note: object names can appear here. |
| `reporting.endpoint` | relay URL | Point at your own relay (see [`worker/`](worker/)). |

### Local control panel

A small HTML button panel for the **read-only** tools — search, grep, get_source,
read_table, ATC, where-used, packages, transports, dumps, inactive objects — so
you can poke at SAP from a browser without going through an agent.

The trick: the panel is served **from inside the MCP process itself**, reusing
the same tool handlers. So it is reachable **only while a session keeps the MCP
connected** — close the session (or disconnect the MCP) and the process exits,
taking the panel down with it. There is no standalone server to leave running.

**Open it from a session (easiest).** Just ask the agent to open it — that calls
the **`adt_open_panel`** tool, which starts the panel on demand and opens the URL
in your browser. **`adt_close_panel`** stops it. In Claude Code the bundled
**`/panel`** command does the same (`/panel`, `/panel url`, `/panel close`).
Nothing listens until you ask — the socket opens only on that call.

**Or auto-start at boot.** Set it in config or env and it comes up with the
server:

```json
{ "panel": { "enabled": true, "port": 0 } }
```

…or `SAP_ADT_MCP_PANEL=1` (`SAP_ADT_MCP_PANEL_PORT` pins a port; `port: 0` / unset
picks a random free one). On boot the server prints the URL, e.g.:

```
[sap-adt-mcp] panel: ready (read-only) → http://127.0.0.1:39555/?t=<token>
```

Safety: bound to `127.0.0.1` only, gated by a per-boot random **token** in that
URL, and limited to a curated **read-only** allowlist — no write tool (set_source,
activate, delete, lock, transport release) is reachable from a button, regardless
of config. Each tool's form is rendered from its live input schema, and the
system selector at the top targets any configured system.

## Connect a client

### Claude Code (CLI)

```bash
claude mcp add sap-adt -- npx sap-adt-mcp
```

Pass secrets through the registration:

```bash
claude mcp add sap-adt \
  --env SAP_DEV_PASSWORD=... \
  --env SAP_PRD_PASSWORD=... \
  -- npx sap-adt-mcp
```

### Claude Desktop

Edit `claude_desktop_config.json` (Settings → Developer → Edit Config):

```json
{
  "mcpServers": {
    "sap-adt": {
      "command": "npx",
      "args": ["-y", "sap-adt-mcp"],
      "env": {
        "SAP_DEV_PASSWORD": "..."
      }
    }
  }
}
```

Quit and restart Claude Desktop fully (system tray → Quit) for the change to
apply.

### Validate before connecting

```bash
npx sap-adt-mcp --validate-config
```

Loads the config and pings every system; exits non-zero if any are unreachable
or rejecting credentials. Run this first when troubleshooting.

## Tools

### Object-source CRUD

| Tool | Purpose | Notes |
| --- | --- | --- |
| `adt_get_source` | Fetch ABAP source by object name + type. | Returns plain text. For classes, pick the include via `include`: `main` (default), `definitions`, `implementations`, `macros`, `testclasses`. Function modules require `group`. For large objects, pass `outputFile` to write the source straight to disk (response omits inline `source`). |
| `adt_set_source` | Replace source. Orchestrates lock → PUT → unlock. | Supply the new source inline via `source`, or via `sourceFile` (a local path the MCP reads itself) for large objects that exceed the per-call I/O cap. Optional `transport` assigns the change to a TR (`corrNr`); optional `lockHandle` reuses an externally-acquired lock. Refused under `readOnly: true`. |
| `adt_create_object` | Create a new ABAP object in a package. | Supported types: program, class, interface, include, functiongroup, function, cds, accesscontrol, metadataext, behaviordef, messageclass. After creation, set the source body with `adt_set_source` and activate. Refused under `readOnly: true`. |
| `adt_delete_object` | Delete an object. | Acquires lock and DELETEs. Refused under `readOnly: true`. |
| `adt_activate` | Activate one or more objects. | Pass `objects: [{ name, type, group? }]`. |
| `adt_pretty_print` | Run the SAP-side ABAP formatter. | Stateless — pass source, get formatted source back. |
| `adt_lock` / `adt_unlock` | Acquire / release a lock for multi-step edits. | For one-shot edits, prefer `adt_set_source` (manages the lock for you). Use these when you need to keep an object locked across multiple writes within a single agent turn. |

### Quality

| Tool | Purpose | Notes |
| --- | --- | --- |
| `adt_syntax_check` | ADT syntax check on an object. | Returns `<chkrun:reports>` XML; the agent reads severity + line numbers. |
| `adt_run_unit_tests` | ABAP Unit run. | Pass test container objects (typically classes). |
| `adt_run_atc` | ABAP Test Cockpit run. | API surface varies across NW releases — see Caveats. |

### Discovery

| Tool | Purpose | Notes |
| --- | --- | --- |
| `adt_browse_package` | One level of package contents. | |
| `adt_list_packages` | Recursive walk from a root. | Has `prefix` (only descend into matching subpackages) and `maxPackages` safety cap (default 200). |
| `adt_search_objects` | Quick-search by name pattern. | `*` wildcard. Returns parsed `{ name, type, description, packageName, uri }` records. |
| `adt_where_used` | Where-used list. | Same parsed record shape. Capped at `maxResults` (default 200); the response carries the backend's own `numberOfResults` plus `truncated` when the list was cut. |

### Cross-system

| Tool | Purpose | Notes |
| --- | --- | --- |
| `adt_compare_source` | Diff one object between two systems. | Returns unified diff + `{ added, removed }` stats. |
| `adt_transport_diff` | Diff every object in a TR between two systems. | Caps at `maxObjects` (default 50). |

### Runtime errors

| Tool | Purpose | Notes |
| --- | --- | --- |
| `adt_list_dumps` | List ST22 short dumps. | Optional filters: `user`, `host`, `from`/`to` (YYYYMMDD), `maxResults` (default 20). Atom feed is parsed into structured entries with `runtimeError`, `program`, `user`, `updated`, and release-specific `rba:*`/`dump:*` fields surfaced as a map. Trims client-side because some releases ignore the server-side cap. |
| `adt_get_dump` | Fetch a single dump by id. | Two-step fetch: metadata XML (runtime error, program, links) followed by the formatted dump text from the `dump:link relation="contents"` sub-resource. Returns a `chapters` map (shortText, whatHappened, errorAnalysis, howToCorrect, whereTerminated, sourceCodeExtract, …). Pass `chapters: [...]` to limit, `full: true` to include the raw text. |

### Debugger

External ABAP debugger over ADT's `/sap/bc/adt/debugger/*` API. Set a breakpoint,
wait for a session to hit it, then inspect the stack/variables, step through, and
(guarded) change values. Requires debug authorization on the backend; minimum
NW 7.31 SP04 + Kernel 7.21 (fine on S/4).

| Tool | Purpose | Notes |
| --- | --- | --- |
| `adt_debug_set_breakpoint` | Set an external breakpoint. | Give `uri`, or `object`+`type`(+`include`)+`line`. Optional `condition`. Returns the breakpoint `id`. |
| `adt_debug_delete_breakpoint` | Remove a breakpoint by `id`. | |
| `adt_debug_listen` | Bounded wait for a debuggee to hit a breakpoint. | Returns `{ caught: true, debuggee, … }` and auto-attaches, or `{ caught: false }` on timeout (default 30 s, capped 55 s) — just call again. One listener per process. |
| `adt_debug_stack` | Call stack of the attached debuggee. | |
| `adt_debug_variables` | Read variable values. | `names: ['sy-subrc','lv_total']`; omit for the scope roots. |
| `adt_debug_step` | Advance execution. **WRITE.** | `kind`: `into` / `over` / `return` / `continue` / `runToLine` / `jumpToLine` (need `uri`) / `terminate`. A `continue` that lets the run finish answers `status: "debuggeeEnded"` — that is success. |
| `adt_debug_goto_stack` | Move the active stack frame. **WRITE.** | `stackUri` (from the stack) or 0-based `position`. |
| `adt_debug_set_variable` | Set a variable's value. **WRITE.** | `name` + `value`. Changes live session state. |
| `adt_debug_set_watchpoint` / `adt_debug_delete_watchpoint` | Break when a variable changes. **WRITE.** | Best-effort — the watchpoint contract has no reference impl; check `raw` on a live run. |
| `adt_debug_stop` | End the session: resume the debuggee, then delete the listener + all breakpoints it set. | Call when done so nothing dangles and no request stays suspended. `release: false` skips the resume. |

Typical flow:

```text
1.  adt_debug_set_breakpoint { object: "ZREPORT", type: "program", line: 42 }   → id
2.  adt_debug_listen {}          → ARM IT FIRST, then trigger the run
3.  (trigger: a Fiori/OData call, an ADT classrun, an RFC, a job)
4.  listen returns caught:true → already attached (or caught:false → call again)
5.  adt_debug_stack {}           → where execution paused
6.  adt_debug_variables { names: ["sy-subrc", "lv_total"] }
7.  adt_debug_step { kind: "over" }   → advance; or set_variable / continue
8.  adt_debug_stop {}            → resume the debuggee + cleanup
```

**What an external breakpoint traps:** HTTP/ICF (Fiori, OData, ADT), RFC and
background sessions — **not your own SAP GUI dialog session**. Running the report
from SE38 with F8 traps nothing and opens no debugger, which reads like a broken
feature but isn't. To debug dialog-only code, run it inside an ICF session with a
throwaway `IF_OO_ADT_CLASSRUN` wrapper and trigger
`POST /sap/bc/adt/oo/classrun/<class>`:

```abap
METHOD if_oo_adt_classrun~main.
  DATA lt_list TYPE TABLE OF abaplist.
  " There is no screen in an ICF session, so list output must go to memory.
  SUBMIT zoy_dbg_target EXPORTING LIST TO MEMORY AND RETURN.
ENDMETHOD.
```

`SUBMIT` opens a fresh program context, so you debug the target report on its own.

**Timing:** arm `adt_debug_listen` *before* triggering the run — for a fast
request (Fiori/OData) arming it after clicking is already too late. A trapped
debuggee then waits only ~15–20 s for the attach before resuming on its own, so
`listen` attaches immediately with no round trip in between. A `caught: false`
can therefore mean three things: the run hasn't happened yet, the listener was
armed too late, or that line never executes in this flow — keep a known-good
control breakpoint to tell a wrong breakpoint apart from a setup problem.

**Read-only mode:** inspection (breakpoints, listen, stack, variables) is allowed;
the **WRITE** tools above (step, goto-stack, set-variable, watchpoints) are refused
under `readOnly: true`. Debugging **another user's** session (`requestUser`) is off
by default; enable it per system with `"debug": { "allowRequestUser": true }`
(needs backend debug authorization).

### Data

| Tool | Purpose | Notes |
| --- | --- | --- |
| `adt_read_table` | Run an OpenSQL SELECT via the ADT Data Preview API. | SE16-style table reads. SELECT-only — INSERT/UPDATE/DELETE rejected client-side; the SAP endpoint enforces server-side too. `maxRows` capped at 5000 (default 100). Requires NetWeaver 7.55+ / S/4HANA. |

### Transports

| Tool | Purpose | Notes |
| --- | --- | --- |
| `adt_list_transports` | List TRs by user / status. | Default user = config user; default status = `modifiable`. |
| `adt_get_transport` | TR header + objects. | |
| `adt_create_transport` | Create a new TR. | Refused under `readOnly: true`. Endpoint shape varies — see Caveats. |
| `adt_release_transport` | Release a TR. | Refused under `readOnly: true`. |

### Control panel

| Tool | Purpose | Notes |
| --- | --- | --- |
| `adt_open_panel` | Start the local read-only HTML control panel and return its URL. | Opens the URL in the browser by default (`open: false` to just return it). Reachable only while this session keeps the MCP connected. See [Local control panel](#local-control-panel). |
| `adt_close_panel` | Stop the panel. | It also stops on its own when the session ends. |

### Escape hatch

`adt_request` — direct ADT REST call. Use this when a niche endpoint isn't
covered by a high-level tool. Handles auth / CSRF / cookies / sap-client
automatically.

### Object types

Friendly aliases (any of either column work):

| Alias | TADIR code |
| --- | --- |
| program / report | PROG |
| include | INCL |
| class | CLAS |
| interface | INTF |
| function / fm | FUGR/FF (requires `group`) |
| functiongroup | FUGR |
| table / structure | TABL |
| dataelement | DTEL |
| domain | DOMA |
| cds / ddls | DDLS |
| accesscontrol / dcls | DCLS |
| metadataext / ddlx | DDLX |
| behaviordef / bdef | BDEF |
| messageclass / msag | MSAG |

## Skills (packaged workflows)

The raw tools are building blocks; [`skills/`](skills/) ships ready-made
workflows for Claude Code that orchestrate them. Each SKILL.md lists its own
prerequisites (minimum NetWeaver release, required authorizations, read-only
compatibility).

| Skill | What it does | Read-only OK? | Min. system |
| --- | --- | --- | --- |
| [`transport-release-gate`](skills/transport-release-gate/SKILL.md) | Pre-release quality gate over a TR: inactive objects, locks, syntax, ATC, unit tests → go/no-go report. Release stays a human decision. | Mostly (unit tests + release need write) | NW 7.50+, ATC configured |
| [`dump-triage`](skills/dump-triage/SKILL.md) | ST22 triage: group dumps into families, deep-read top offenders, root cause + fix per family. | Yes — safe on PRD | NW 7.50+ (dumps feed) |
| [`legacy-code-doc`](skills/legacy-code-doc/SKILL.md) | Reverse-document legacy Z code: structure, DB touchpoints, callers, risks, S/4 migration notes. | Yes — safe on PRD | NW 7.4x+ (data samples 7.55+) |
| [`abap-clean-core`](skills/abap-clean-core/SKILL.md) | SAP Clean Core framework knowledge: levels, decision framework, governance. | Yes (knowledge-only) | none |

To use one, copy its folder into your project's `.claude/skills/` (or
`~/.claude/skills/` for all projects):

```bash
cp -r node_modules/sap-adt-mcp/skills/dump-triage .claude/skills/
# or from a clone: cp -r sap-adt-mcp/skills/dump-triage .claude/skills/
```

Claude Code picks them up automatically; they trigger when the conversation
matches (e.g. "is E4DK900123 safe to release?" → transport-release-gate).

## Clean Core: prompts + reference

The server ships an opt-in **Clean Core** layer for SAP S/4HANA work.
There are two pieces, and they are deliberately separate:

- **Five MCP prompts** (`src/prompts.js`) — the operational surface. The
  user invokes them as slash commands. Each one pairs a slice of the
  Clean Core framework with the relevant `adt_*` tools so the model can
  act on a real system, not just lecture about levels.
- **Long-form reference** ([`skills/abap-clean-core/`](skills/abap-clean-core/))
  — the framework's full text: Stay Clean / Get Clean playbook, A/B/C/D
  level deep-dive, Cloudification Repository state semantics, ABAP Cloud
  allowed/forbidden lists, the SAP Application Extension Methodology
  (3 phases), governance practices, KPI calculations, ATC exemption
  process. Read once, link to it from PRs, hand to a new team member.
  The prompts above quote what they need; the reference is everything
  else.

### Design choices

- **Opt-in, not auto-firing.** Clean Core is an S/4HANA discipline. ECC
  developers should not have it imposed on them. Nothing fires unless the
  user types the slash command.
- **ECC applicability check baked into every prompt.** The first thing
  each prompt body asks the model to do is verify the target system is
  S/4HANA. On ECC, it backs off and offers help in classic-ABAP idioms
  with no level labels.
- **Tone is descriptive, not judgmental.** "I know it's Level D, just
  ship it" is honored. The agent ships, marks the level, sketches the
  Level A refactor for later, and moves on.

### The prompts

In Claude Code (assuming you registered the server as `sap-adt`), the
exact commands are:

| Command | Arguments | What it does |
| --- | --- | --- |
| `/mcp__sap-adt__clean_core_grade` | `object` (req), `type` (req), `system` | Grade one object A/B/C/D. Pulls source + ATC, classifies, cites reasons, sketches the Level A refactor if Level C/D. |
| `/mcp__sap-adt__clean_core_review` | `package` (req), `system`, `maxObjects` (default 50) | Walk a package and compute Clean Core Share %, Tech Debt Score, top Level D offenders. |
| `/mcp__sap-adt__clean_core_refactor` | `object`, `type`, `system` (all optional) | Enter refactor mode. Loads BAPI-wrapper / MARA→released-CDS / modification→BAdI patterns. With `object` it pre-seeds; without, waits for direction. |
| `/mcp__sap-adt__clean_core_create` | `requirement`, `package`, `system` (all optional) | Enter creation mode at Level A by default — ABAP Cloud syntax, released CDS views, RAP, business object interfaces. Drives the `create_object → set_source → syntax_check → activate` pipeline. |
| `/mcp__sap-adt__clean_core_design` | `use_case` (optional) | Architecture mode — fit-to-standard, 3-phase methodology, on-stack vs side-by-side, hybrid. No code writes. Produces a target-solution memo. |

The slash-command name structure is determined by the MCP client: the
`mcp__<server-alias>__` prefix is added automatically based on the alias
you used when registering the server. If you registered the server with
a different alias (e.g. `claude mcp add cc -- npx sap-adt-mcp`), the
prefix changes accordingly (`/mcp__cc__clean_core_grade`).

In Claude Desktop, prompts appear in the slash-command picker — same
naming.

### Argument flow examples

Atomic prompts (`grade`, `review`) take all their arguments inline and
return a structured analysis:

```
You: /mcp__sap-adt__clean_core_grade object:ZCL_PRICING type:class system:DEV
Agent: → adt_get_source { ... }
       → adt_run_atc { ... }
       Verdict: Level C. Two SELECTs from MARA without using the released
       I_Product view; one CALL FUNCTION to internal FM RV_PRICE_PRINT.
       Refactor sketch: replace SELECT with `from I_Product`; encapsulate
       the RV_PRICE_PRINT call in a Z-class so the dependency is localised.
```

Mode-loading prompts (`refactor`, `create`, `design`) optionally take a
seed; without one, they wait for the user's natural-language follow-up:

```
You: /mcp__sap-adt__clean_core_create
Agent: I'm in Clean Core CREATE mode (Level A by default). What do you
       want to build, on which package and system?
You:   A small Fiori list-report of overdue invoices, package ZFIN_REPORTS,
       system DEV.
Agent: Plan: a CDS view projecting I_OperationalAcctgDocItemCube for items
       with NetDueDate < today; a behavior definition; a service binding
       exposing it to Fiori Elements list-report. Three objects. Confirm?
```

Or with a seed argument so the request is one-shot:

```
You: /mcp__sap-adt__clean_core_create requirement:"Fiori list-report of
     overdue invoices" package:ZFIN_REPORTS system:DEV
```

### Read the long-form reference

[`skills/abap-clean-core/`](skills/abap-clean-core/) is the canonical
source for everything the prompts quote and more. If you're setting up
Clean Core governance for a real program — KPI baselines, ATC exemption
discipline, maturity assessment, on-stack vs side-by-side trade-offs at
the architecture level — that's where the depth lives.

The directory is structured as one entry point (`SKILL.md`) plus four
deep-dive files in `references/`:

- `references/levels-detailed.md` — Cloudification Repository state
  values, released local vs released remote APIs, reclassification
  dynamics, per-anti-pattern remediation
- `references/decision-framework.md` — fit-to-standard, the SAP
  Application Extension Methodology in detail, on-stack vs side-by-side
  triggers, hybrid patterns, worked scenarios
- `references/governance.md` — Stay Clean / Get Clean playbook, the four
  KPIs and how to compute them, ATC exemption process, maturity
  assessment, multi-year roadmap
- `references/abap-cloud-rules.md` — full allowed/forbidden lists, RAP /
  CDS / business object interfaces / Custom Fields, prebuilt services,
  classic-to-cloud migration patterns

You can install the reference as an actual auto-loading Claude skill by
copying or symlinking `skills/abap-clean-core/` into your
`~/.claude/skills/` — but that's an explicit choice. The default
behavior of this repo is opt-in, prompt-only.

## Examples

See [`examples/`](examples) for end-to-end agent workflows: project discovery,
class audit, cross-system release verification, where-used-driven refactor,
test triage.

Quick taste:

```
You: "Compare class ZCL_PRICING between DEV and PRD on the live systems."
Agent: → adt_compare_source { systemA: "DEV", systemB: "PRD",
                              object: "ZCL_PRICING", type: "class" }
       Returns: { identical: false, stats: { added: 14, removed: 9 },
                  diff: "..." }
       Then narrates the meaningful changes.
```

## Architecture

```
MCP client (Claude Desktop / Claude Code / custom)
         │  stdio (JSON-RPC)
         ▼
  ┌──────────────────────────────────┐
  │  src/server.js                   │  CLI + MCP dispatch (thin)
  │   ├─ src/tools/*.js              │  one module per category:
  │   │                              │    connection, source, quality,
  │   │                              │    lifecycle, discovery,
  │   │                              │    cross-system, transports,
  │   │                              │    runtime, data, request
  │   ├─ src/object-uris.js          │  type alias → ADT URI map
  │   ├─ src/node-structure.js       │  package tree XML parser
  │   ├─ src/object-references.js    │  <objectReference> parser
  │   ├─ src/dump-feed.js            │  runtime-dumps Atom parser
  │   ├─ src/data-preview.js         │  Data Preview XML parser + SELECT guard
  │   ├─ src/diff.js                 │  unified diff (LCS)
  │   ├─ src/adt-error.js            │  <exc:exception> parser
  │   ├─ src/lock.js                 │  ADT lock acquire / release
  │   └─ src/adt-client.js           │  HTTP client: auth / CSRF / cookies / timeout
  └──────────────────────────────────┘
         │  HTTPS
         ▼
   SAP system (ADT REST: /sap/bc/adt/...)
```

Two runtime dependencies: `@modelcontextprotocol/sdk` (the MCP wire protocol)
and `undici` (HTTP with custom TLS dispatcher). Everything else is stdlib.

## Multi-step editing pattern

For most edits, `adt_set_source` is enough — it acquires the lock, writes,
and releases. For workflows that touch the same object multiple times within
a single turn (e.g. apply N method-level patches, then activate), use the
sticky-lock pattern:

```text
1.  adt_lock { object: "ZCL_X", type: "class" }              → returns lockHandle
2.  adt_set_source { object: "ZCL_X", type: "class",         (repeat as needed)
                     source: "...", lockHandle: "<handle>" }
3.  adt_activate { objects: [{ name: "ZCL_X", type: "class" }] }
4.  adt_unlock { object: "ZCL_X", type: "class",
                 lockHandle: "<handle>" }
```

The `lockHandle` parameter on `adt_set_source` skips internal lock/unlock
when present.

### Large objects (thousands of lines)

A multi-thousand-line class or program can exceed the per-call I/O cap, so its
source cannot be passed inline. Keep the content on disk instead — it never
enters the agent context:

```text
1.  adt_get_source { object: "ZCL_BIG", type: "class",
                     outputFile: "/tmp/zcl_big.abap" }   → writes the file, no inline source
2.  (edit /tmp/zcl_big.abap locally)
3.  adt_set_source { object: "ZCL_BIG", type: "class",
                     sourceFile: "/tmp/zcl_big.abap",
                     transport: "E4DK900123" }           → MCP reads the file and PUTs it
```

Note: assigning to a transport works headless, but TR *creation*
(`adt_create_transport`) routes through a GUI dialog on some systems and can
fail with a 500 — pass an existing TR id instead.

## Caveats

- **NetWeaver release variation.** A few ADT endpoints (especially around
  transport requests, ATC, and object-create XML shapes) have small shape
  differences across NW 7.5x, S/4 on-prem, and Steampunk. If a high-level
  tool fails with HTTP 4xx, the tool description notes which endpoint it
  hits — fall back to `adt_request` with the right path / content type for
  your release.
- **ABAP Cloud (BTP / Steampunk).** Only on-prem ADT 7.5x+ has been actively
  exercised. Steampunk uses a stricter object-type allowlist (only released
  / public APIs) and some collection endpoints differ. Steampunk users:
  please open an issue with the endpoints that differ; PRs welcome.
- **Object-create XML shapes.** The body templates target modern on-prem
  releases. Some older systems require additional attributes
  (`adtcore:masterLanguage`, etc.) — open an issue if your system rejects
  the create payload, and include the response body.
- **DDIC primitives** (tables, data elements, domains) are not creatable via
  `adt_create_object` — these need a richer DDIC-specific payload that we
  haven't generalised. Use `adt_request` for now.

## Troubleshooting

**"failed" in Claude Desktop's MCP server list.** Run `sap-adt-mcp
--validate-config` from a terminal. If that prints OK, the server is fine and
the issue is in your `claude_desktop_config.json` (wrong path or env).

**403 with `x-csrf-token: required`.** Should self-heal — the client refetches
the token and retries. If it persists, you likely have an SSO / front-end
auth in front of ADT that breaks Basic auth; check your ICM and SAP web
dispatcher rules.

**Read-only mode refuses an obviously-read endpoint.** It's probably a POST
endpoint not in the whitelist. Open a PR or issue with the path; we'll add
it. Or temporarily flip the system to `readOnly: false`.

**`SAP_ADT_MCP_DEBUG=1`** traces every request and response (status, latency,
URL, request headers minus `Authorization`) to stderr. The MCP client shows
stderr in its server log, so check there.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) — bug reports, new tool coverage,
NetWeaver compatibility notes, docs, examples all welcome.

## License

MIT — see [LICENSE](LICENSE).
