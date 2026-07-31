# Changelog

All notable changes to this project will be documented in this file. Format
roughly follows [Keep a Changelog](https://keepachangelog.com/) and the project
adheres to semantic versioning once it reaches 1.0.0.

## [Unreleased]

## [0.8.57]

### Fixed

- **The debugger tool set was unusable (#101).** Three HTTP-contract defects,
  all reproduced and then verified fixed end to end on a live system:
  - **Missing stateful session.** ADT's debugger is a stateful protocol: `attach`
    opens a debug session bound to the ABAP session, and every later call must
    run inside it. Nothing sent `X-sap-adt-sessiontype: stateful`, so `attach`
    answered 200 and looked fine while `stack` / `variables` / `step` all failed
    with 404 `noSessionAttached`. The header is now on `attach` and every call
    after it.
  - **Wrong `Accept` on the listener.** `/debugger/listeners` serves exactly one
    media type (`application/vnd.sap.as+xml`). The failure mode was silent: with
    anything else the long poll just sat there and the tool reported
    `caught: false` — indistinguishable from "nothing hit the breakpoint".
    A backend rejection (406) is now reported as the error it is.
  - **A successful `continue` was reported as a 500.** `stepContinue` on a
    debuggee that nothing else traps lets the ABAP session finish before ADT can
    answer, so the step comes back as 500 `SY/530` `debuggeeEnded` while the
    triggering request returns 200. That is the operation succeeding; it now
    answers `status: "debuggeeEnded"` with an explanation instead of an error.

  Also: a failed `attach` no longer records a session that doesn't exist (and
  says so when the debuggee had already resumed), `noSessionAttached` answers
  with the recovery step, and `adt_debug_stop` now resumes the attached debuggee
  (`release`, default true) before cleaning up, so no suspended request is left
  hanging. The tool descriptions and README now state what an external
  breakpoint actually traps (HTTP/ICF, RFC, background — *not* your own SAP GUI
  dialog session), the `classrun` + `SUBMIT` workaround for dialog-only code,
  and that the listener must be armed before the run is triggered.

- **`adt_create_object` 500 on a function module in a namespaced group (#100).**
  The POST target percent-encoded the group name, but the `containerRef` inside
  the body did not — `/FGLR/DEVC` became `…/functions/groups//fglr/devc`, an
  extra path segment pointing at a resource that doesn't exist, so the backend
  answered 500. Both places now encode the group as one path segment.
- **`adt_create_object type=functiongroup` never worked.** Found while verifying
  the above: a stock S/4 (SAP_BASIS 755) rejects the declared v3 media type with
  400 `ExceptionInvalidData` ("Data is invalid and could not be converted") and
  accepts the identical body as v2. The media-type fallback only retried on 415,
  so the create always failed. It now also walks down the version chain on a
  400 `ExceptionInvalidData`. Verified end to end on a live system: function
  group + function module created in `$TMP` and deleted again.

### Changed

- **`adt_where_used` no longer floods the context.** A central object can carry
  five figures of references (`CL_GUI_FRONTEND_SERVICES`: 11117 parsed entries,
  ~126 KB in one tool result). The list is now capped at `maxResults`
  (default 200) and the response carries `numberOfResults` — the backend's own
  count from `usageReferenceResult` — plus `truncated` / `totalParsed` when the
  list was cut.

## [0.8.55]

### Changed

- **Stop auto-reporting more business/backend 500s (#89–92).** Four recurring
  `auto-adt-error` reports were user/object/system-side, not tool defects, so the
  reporter no longer files them:
  - `adt_create_object` "…already exists" (a create hitting an existing object;
    #92).
  - `adt_get_source` `ExceptionResourceReadFailure` — a specific object couldn't
    be read on the backend, like a 404 (#91).
  - `adt_get_source` generic backend `SY/530` "An exception was raised" while
    reading a special/generated object (#89).
  - `adt_read_table` 5xx — the caller's OpenSQL blowing up on the backend
    (unknown column, etc.), not a request-shape defect (#90).

  Content-negotiation defects (406/415) are still reported.

## [0.8.54]

### Added

- **Debugger Phase 2 + 3 — flow control & value writes (#88).** Completes the
  debugger tool set on top of Phase 1's inspection tools:
  - `adt_debug_step` — advance the debuggee: `into` / `over` / `return` /
    `continue` / `runToLine` / `jumpToLine` / `terminate`.
  - `adt_debug_goto_stack` — move the active stack frame (by `stackUri` or
    `position`).
  - `adt_debug_set_variable` — set a variable's value in the live session.
  - `adt_debug_set_watchpoint` / `adt_debug_delete_watchpoint` — variable-change
    watchpoints (best-effort: no reference implementation for the contract, so
    the raw ADT XML is returned for validation).

  All five are WRITE operations and are refused under `readOnly: true` (gated at
  the tool level, since the shared `/sap/bc/adt/debugger` path can't be
  distinguished from the inspection POSTs by path alone). step / goto-stack /
  set-variable shapes are verified against abap-adt-api's `src/api/debugger.ts`.

## [0.8.53]

### Added

- **ABAP debugger tool set — Phase 1 (inspection) (#88).** The one workflow the
  MCP couldn't do before. Six tools over ADT's `/sap/bc/adt/debugger/*` REST API:
  - `adt_debug_set_breakpoint` / `adt_debug_delete_breakpoint` — external
    line breakpoints (by `uri`, or `object`+`type`+`line`; optional `condition`).
  - `adt_debug_listen` — bounded long-poll (default 30 s, capped 55 s) that
    returns `{ caught: false }` on timeout (call again) or auto-attaches and
    returns the debuggee when a session hits a breakpoint.
  - `adt_debug_stack` / `adt_debug_variables` — inspect the attached session.
  - `adt_debug_stop` — delete the listener and every breakpoint it set.

  The listener and its breakpoints share one stable per-process terminal/ide id.
  Debugging another user's session (`requestUser`) is off unless a system sets
  `"debug": { "allowRequestUser": true }`. Debug inspection is allowed under
  read-only mode (it doesn't modify objects); flow-control and value writes
  (step / set-variable) are a later phase and will gate on read-only.

  Endpoint shapes verified against abap-adt-api's `src/api/debugger.ts`. Each
  tool also returns the raw ADT XML alongside its parsed summary.

## [0.8.52]

### Fixed

- **`adt_browse_package` crashed on a missing/mis-named package (#84).** It read
  `args.package.toUpperCase()` with no guard, so a call with `packageName` (or no
  package) threw `Cannot read properties of undefined`. It now returns a clean
  error that names the wrong field.
- **`adt_delete_object` crashed on bad args (#81).** The `objectUri` build is now
  wrapped, so passing `name` instead of `object` (or an unsupported type) returns
  a clean error instead of crashing.

### Changed

- **Stop auto-reporting `adt_create_transport` 500 (#78).** TR *creation* routes
  through a SAP GUI dialog on many systems and 500s headless regardless of the
  request (the 0.8.50 blank-target fix didn't change it — the operation itself
  needs GUI). Treated as environmental, like the CSRF/dependency-graph cases in
  0.8.49. Assigning to an existing TR still works headless.
- **Relay de-dup now matches closed issues too.** A fixed defect re-reported by
  an un-upgraded install used to spawn a brand-new issue every time (open-only
  search); it now comments on the existing closed issue (without reopening)
  instead. (worker)

## [0.8.51]

### Fixed

- **`adt_where_used` returned 400 for every object (#73).** The POST sent no
  request entity, but the endpoint requires a body with a `<usageReferenceRequest>`
  root (`System expected the element usageReferenceRequest`). It now sends that
  body (empty `<affectedObjects/>` = all usages) with `Content-Type: application/*`,
  mirroring the reference client, and parses the `usageReferences:adtObject`
  result shape (with a fallback to the flat `objectReference` shape).
- **`adt_where_used` crashed on a function module without `group` (#74).** The
  `objectUri` throw for `FUGR/FF` was uncaught; it now returns a clean error
  asking for `group`. `adt_set_source` got the same guard.
- **`adt_set_source` 415 on DDIC primitives (#72).** Writing a domain / data
  element / message class PUT `text/plain`, which the XML-metadata resources
  reject. It now PUTs with the resource's own media type (e.g.
  `application/vnd.sap.adt.domains.v2+xml`, symmetric with `adt_get_source`) and
  skips the ABAP partial-source guard for these types.

## [0.8.50]

### Added

- **Edit large objects without hitting the I/O cap (#39).** A big class/program
  could be read (large reads auto-persist to a file) but not written back, since
  the new source had to be an inline string. Two symmetric params close the gap:
  - `adt_set_source` accepts `sourceFile` (a local path); the MCP process reads
    it and PUTs it, so there is no size ceiling. Mutually exclusive with
    `source`.
  - `adt_get_source` accepts `outputFile`; the fetched source is written straight
    to disk and the response omits the inline `source` (returns `bytesWritten`).
    Respects `firstLine`/`lastLine`/`onlyMethod`.

  This makes read → edit-on-disk → write round-trips for multi-thousand-line
  objects possible without the source ever passing through the agent context.

### Fixed

- **`adt_set_source` 500 from a blank transport (#68).** A transport passed as a
  whitespace string (`" "`) reached the CTS backend as `corrNr=%20` and 500'd.
  `AdtClient` now drops null/undefined/blank query values uniformly, so every
  `corrNr`-bearing tool (set_source, chunked, activate/delete, rap) is covered.
- **`adt_syntax_check` 500 uriMappingError on a namespaced context (#67).** A
  namespaced program name like `/FGLR/R_PO_ASSET_CREATE` starts with `/`, so it
  was mistaken for a ready-made ADT URI and produced an unmappable `?context=`.
  Only the `/sap/bc/adt/` prefix now marks a URI; everything else is encoded as a
  program name.
- **`adt_get_source` 406 on a subtyped DDIC type (#66).** `type: "DOMA/DD"` was
  not collapsed before the metadata-XML Accept lookup, so it missed the table and
  fetched `text/plain` (which domains 406). A new `baseType` collapses decorative
  subtypes (`DOMA/DD` → `DOMA`) for the lookup.
- **`adt_create_object` 415 on CDS/DDLS (#64).** Some systems register neither
  versioned media type for a create; the reference client (abap-adt-api) always
  creates with `application/*`. The 415 fallback chain now ends with that
  wildcard, rescuing systems that reject every versioned type.
- **`adt_get_source` no longer crashes on wrong param names (#65).** Passing
  `object_name`/`object_type` (instead of `object`/`type`) already returned a
  clean error rather than the old `normalizeType` crash; the hint now names the
  exact wrong field.
- **`adt_create_transport` no longer sends `tm:target=""` (#63).** An empty
  target attribute could trigger an opaque 500; it is now omitted so CTS applies
  the default route. (TR *creation* may still need SAP GUI on some systems —
  assign changes to an existing TR headless instead; documented on the tool.)

### Internal

- Automatic error reports now carry an anonymous, random install id (cached at
  `~/.sap-adt-mcp/install-id`) so repeat reports from one install can be grouped
  for triage. It identifies neither the user nor the system, and is only written
  when reporting is enabled.

## [0.8.49]

### Changed

- **Stop auto-reporting environmental / system-side conditions as bugs.** Two
  recurring auto-reports were not tool defects, so the crash reporter no longer
  files them:
  - `Failed to fetch CSRF token` (crash channel) — the host answered with an
    HTML page (SSO/login, web dispatcher, or a wrong host/system), never a
    mis-shaped request on our side (#62; same class as the deleted #58–60).
  - `NoDependencyGraphDataCalculationPossible` from `adt_cds_dependencies`
    (adt-error channel) — SAP can't compute the dependency graph for that CDS
    entity, a system/data-side condition (#61; previously triaged in #22).
- **Clearer CSRF-fetch error.** When the CSRF probe gets an HTML body, the error
  now says the host returned an HTML page (likely an SSO/login page or wrong
  host) and to check the system's host and basic-auth ADT access — instead of
  dumping raw HTML.

## [0.8.48]

### Fixed

- **`adt_cds_data_preview` 406 ExceptionResourceNotAcceptable (#53, #36).** The
  CDS Data Preview POST sent `Accept: application/xml`, but the endpoint only
  serializes a result set as `application/vnd.sap.adt.datapreview.table.v1+xml`
  (the same media type the `adt_read_table` fix uses). Every row-returning CDS
  preview 406'd; now fixed.
- **`adt_run_atc` / `adt_run_unit_tests` crashed on the singular `object` shape
  (#40).** Callers reaching for `{ object, type }` (as `adt_get_source` uses)
  left `args.objects` undefined and threw `TypeError: Cannot read properties of
  undefined (reading 'map')`. Both now validate `objects` up front and return a
  clean tool error pointing at the plural `objects: [{ name, type }]` shape.
- **Misconfigured `host` now fails loudly at config load (root cause of #41–48).**
  A host without an `http(s)://` scheme (or an otherwise unparseable one) used to
  throw the cryptic "ADT path is not a valid URL component" on every single tool
  call. `loadConfig` now validates the scheme up front with an actionable message
  naming the system. Config paths are also resolved at call time so
  `SAP_ADT_MCP_CONFIG` is always honoured.

## [0.8.47]

### Fixed

- **Control panel stuck on "Yükleniyor…".** The 0.8.46 page script contained
  `v.indexOf("\n")` inside the served-HTML template literal, so the `\n` resolved
  to a real newline at serve time and produced an unterminated string literal in
  the browser — the inline script failed to parse and the panel never rendered.
  Escaped it (`\\n`) so the browser receives a valid newline escape. Verified by
  syntax-checking the actually-served script, not just the source.

## [0.8.46]

### Changed

- **Control panel — humanized output and forms.** The panel no longer dumps raw
  JSON. Tool results are now rendered for a human: summary chips for scalar
  fields, HTML tables for result lists (search hits, where-used references,
  package contents, table rows, dumps, ATC findings), monospace code blocks for
  source/XML, chapter sections for dump details, a priority histogram for ATC,
  and a red error box (status + message) instead of an error blob. Every result
  keeps a collapsible **"Ham JSON"** toggle so nothing is lost; plain-text replies
  (e.g. ping) and unparseable bodies fall back to a code block.
- **Control panel — friendlier inputs.** A panel-only field overlay re-presents
  each tool's form for non-technical use without touching the agent-facing
  schemas: Turkish labels, example placeholders, sensible defaults, and
  **dropdowns** for value-constrained fields (object type, search type filter,
  transport status, class include). Technical/rarely-used fields collapse under a
  **"Gelişmiş ayarlar"** block; the global system selector still drives `system`.

## [0.8.45]

### Added

- **Local read-only control panel.** The MCP process can serve a small HTML
  button panel from `127.0.0.1`, reusing the exact same tool handlers. Because it
  lives inside the MCP process, it is reachable only while a session keeps the MCP
  connected and dies the moment that process exits — there is no standalone
  server. Bound to loopback, gated by a per-boot random token, and limited to a
  curated set of **read-only** tools only (search, grep, get_source, read_table,
  ATC, where-used, packages, transports, dumps, inactive objects) — no write tool
  is reachable from a button. Forms are rendered from each tool's live input
  schema.
- **`adt_open_panel` / `adt_close_panel` tools + `/panel` command.** Open the
  panel on demand from a session ("paneli aç" → the agent calls `adt_open_panel`,
  which starts the listener and opens the URL in the browser); `adt_close_panel`
  stops it. No socket opens until that call. Auto-start at boot is still available
  via `"panel": { "enabled": true }` / `SAP_ADT_MCP_PANEL=1`
  (`SAP_ADT_MCP_PANEL_PORT` pins a port, otherwise a random free port). Tests in
  `test/panel.test.js`.

## [0.8.44]

### Fixed

- **`adt_get_source` crashed on TADIR `TYPE/SUBTYPE` object types (#21).**
  `normalizeType` passed forms like `SRVD/SRV`, `CLAS/OC`, `DDLS/DF` through
  unchanged, but the URI dispatch tables only matched the bare base (`SRVD`,
  `CLAS`, …), so the lookup fell through and threw "Unsupported object type".
  `objectUri`/`sourceUri` now collapse `X/Y` to its base type `X` (keeping the
  function-group subtypes `FUGR/FF` and `FUGR/I` significant), so passing a full
  TADIR type resolves correctly.
- **Unsupported object types surfaced as crashes instead of clean errors (#33).**
  Types with no high-level mapping (e.g. `WAPA`) threw out of `adt_get_source`
  and were auto-reported as crashes. They now return a clean tool error with a
  hint to use `adt_request`.
- **`adt_cds_data_preview` and `adt_cds_dependencies` crashed when `entity` was
  omitted (#30).** Both now validate `entity` up front (and accept `name` /
  `cdsName` as aliases) instead of throwing on `.toUpperCase()` of `undefined`.
- **`adt_list_packages` now accepts a bare `name` as a `root`/`package` alias
  (#32),** so callers that reach for `name` get results instead of a crash on an
  old build / a "root is required" miss.

## [0.8.43]

### Fixed

- **`adt_create_object` failed with 415 on systems that don't accept the newest
  media type (#17).** Each create endpoint sent a single hard-coded, versioned
  content-type (e.g. `…ddlsource.v2+xml`); systems that only support an earlier
  version answered with `415 ExceptionUnsupportedMediaType` and the create just
  failed (reported against `type: "cds"`). Creates now retry with successively
  lower media-type versions (`v3 → v2 → v1`) when the server rejects the
  content-type, so objects create on older NetWeaver / S/4 releases too. Applies
  to every versioned create kind and to the `adt_rap_scaffold` stack, via the new
  shared `postCreate` helper in `src/object-create.js`. Backward-compatible:
  modern systems still succeed on the first attempt with no extra request.

## [0.8.42]

### Fixed

- **DDIC structures routed to the wrong ADT endpoint (#13).** The `structure`
  type alias mapped to `TABL` → `/sap/bc/adt/ddic/tables/…`, so reading, locking,
  or editing a structure hit the tables endpoint (or failed), forcing callers to
  hand-roll raw `adt_request` calls against `/sap/bc/adt/ddic/structures/…`.
  Structures now have their own type (`STRU` → `/sap/bc/adt/ddic/structures/…`),
  so `adt_get_source`, `adt_lock`, `adt_set_source`, and `adt_activate` all work
  with `type: "structure"` — no escape hatch needed. (Found by mining the
  auto-reported issues for `adt_request` usage.)

## [0.8.41]

### Added

- **`mcpName` in package.json** (`io.github.yzonur/sap-adt-mcp`) so the package
  can be published to the official MCP Registry, which verifies namespace
  ownership by matching this field in the published npm package. Repo also gains
  `server.json` (registry manifest) and `smithery.yaml`. No code changes.

## [0.8.4]

### Fixed

- **`adt_request` errors were auto-reported as tool bugs (#13).** The ADT-error
  channel filed non-2xx results from the raw `adt_request` escape hatch — but
  there the caller fully specifies the request, so a 4xx/5xx is the request
  shape, not a defect. The classifier now skips `adt_request` entirely; errors
  from first-class tools are still reported.

## [0.8.3]

### Fixed

- **Crash on mis-shaped tool calls, surfaced by auto-report (#10, #11).** A tool
  call missing a required argument (or using the wrong field name) crashed with
  an opaque `TypeError: Cannot read properties of undefined`. `objectUri` now
  guards the object name; `adt_get_source` validates `object`/`type` up front
  and points the caller at the right fields (`object` not `name`,
  `firstLine`/`lastLine` not `line`/`endLine`); `adt_list_packages` validates
  `root` and accepts `package` as an alias (its sibling `adt_browse_package`
  uses that name). These now return a friendly error instead of throwing.
- **Network failures were auto-reported as bugs (#12).** undici raises a generic
  `TypeError: fetch failed` whose real reason lives on `err.cause`; the reporter
  only inspected `err.code` and filed it as a crash. The ADT client now wraps
  such failures into a clear `ADT request failed (…): <reason>` error carrying
  the underlying code, and the reporter's classifier skips network errors
  (via `err.cause.code`), the wrapped message, and input-validation errors
  (`… is required`, `Unsupported object type`).

## [0.8.2]

### Added

- **Three packaged workflow skills** under `skills/` (now shipped in the npm
  package alongside `abap-clean-core`), each documenting its own prerequisites
  (minimum NetWeaver release, authorizations, read-only compatibility):
  - **`transport-release-gate`** — pre-release quality gate over a transport:
    inactive objects, foreign locks, syntax checks (with include contexts),
    transport-wide ATC, unit tests → structured go/no-go report. Releasing
    stays a human decision; the skill only calls `adt_release_transport` on an
    explicit request.
  - **`dump-triage`** — ST22 triage: list, group into dump families, deep-read
    top offenders (chapters + live source at the termination point), root-cause
    hypothesis and fix per family. Fully read-only.
  - **`legacy-code-doc`** — reverse-documentation for legacy Z code: entry
    points, DB touchpoints (writes first), callers/blast radius, risks, change
    history, S/4 migration notes. Fully read-only.
  `abap-clean-core` gained a Prerequisites section for consistency.
- **Local write-audit log.** Every write the server performs against SAP
  (POST/PUT/DELETE/PATCH, excluding whitelisted read-only queries) is appended
  to a local JSONL file — `~/.sap-adt-mcp/audit.log` by default — with
  timestamp, the MCP tool that triggered it, target host/user, method, path,
  HTTP status, and transport (corrNr) when present. Blocked read-only
  violations are logged too (`outcome: "blocked-read-only"`). Local only;
  nothing is transmitted. Configure with `"audit": { "enabled", "path" }` or
  disable via `SAP_ADT_MCP_AUDIT=0`. New `src/audit.js` + `test/audit.test.js`.

## [0.8.1]

### Fixed

- **`adt_read_table` returned `rows: []` despite `totalRows > 0` (#2).** The
  0.8.0 `Accept: …datapreview.table.v1+xml` fix made the endpoint answer 200, but
  that media type serializes a **column-major** document (one `<columns>` block
  per column, each with its own `<dataSet>`) the row parser didn't recognize.
  `parseDataPreview` now transposes the column-major shape into rows (and handles
  self-closing `<data/>` null cells).
- **`adt_list_dumps` ignored the `user` filter (#3).** Several on-prem releases
  ignore the feed's `user` query parameter and return every user's dumps. The
  filter is now enforced client-side (case-insensitive), the same way
  `maxResults` already is.
- **`adt_get_source type=dataelement` always 406'd (#4).** Data elements (and
  domains / message classes) have no plain-text source — they serve XML metadata
  behind a dedicated media type, so the unconditional `Accept: text/plain` got
  406 ExceptionResourceNotAcceptable. These types now request the right
  `…dataelements/domains/messageclass.v2+xml` media type and return the metadata
  as `format: "xml"`.

### Added

- **`adt_syntax_check` can now check includes (#5).** Includes only compile in
  the context of a main program; the tool gained a `context` parameter (main
  program / function group ADT URI or bare name) attached to the include's source
  URI as `?context=`. When omitted it best-effort auto-resolves the include's
  first main program via `…/mainprograms`; if still unresolved the response
  carries a hint.
- **Two more reporting channels (#6).** The crash reporter only saw thrown
  errors — the rarest defect class. Added: (1) an **ADT-error channel** that
  auto-reports the non-2xx results a classifier flags as tool bugs
  (406/415/malformed/5xx; skips auth/404/locks/data-preview SQL), wired through
  `errorResult` → the call-tool wrapper; and (2) an **`adt_report_issue` tool**
  so the agent can file bugs/enhancements it detects in otherwise-successful
  responses. Both reuse the existing redaction/fingerprint/relay pipeline; the
  relay routes the three kinds (`crash` / `adt-error` / `manual`) to distinct
  labels (`auto-reported` / `auto-adt-error` / `agent-reported`) with per-label
  de-dup. New config: `reporting.adtErrors`, `reporting.allowManual` (both
  default true).

## [0.8.0]

### Added

- **Automatic, privacy-preserving crash reporting.** When a tool call throws an
  *unexpected* error, the server now sends a redacted, fingerprinted report to a
  relay (a Cloudflare Worker the maintainer owns) which de-duplicates and files a
  GitHub issue. The GitHub token lives only in the relay's secret store — nothing
  secret ships in the package. Reports are scrubbed of hostnames, users,
  passwords, tokens, IPs and emails; expected/user-side errors (read-only
  violations, network/TLS failures, bad credentials, config mistakes) are never
  sent; identical errors de-dup to one issue. On by default with a startup notice;
  disable with `"reporting": { "enabled": false }` or `SAP_ADT_MCP_REPORT=0`. New
  `src/reporter.js`, `worker/` relay, and `test/reporter.test.js`. See README →
  *Automatic error reporting*.

## [0.7.1]

### Fixed

- **`adt_search_objects` — 400 "Parameter ris_request_type could not be found".**
  Quick-search now goes over **GET** (the ADT Eclipse contract) instead of POST.
  The POST routed to the RIS object-search handler, which demanded a
  `ris_request_type` query parameter the tool never supplied; namespace,
  wildcard and plain-name searches were effectively broken on several systems.
  The legacy operation-less fallback is preserved.
- **`adt_read_table` — 406 ExceptionResourceNotAcceptable.** The Data Preview
  POST now sends `Accept: application/vnd.sap.adt.datapreview.table.v1+xml`, the
  only media type the endpoint serializes a result set as. Previously every
  row-returning SELECT failed content negotiation (column/syntax errors still
  came back as 400, so the endpoint was always reached).
- **`adt_where_used` — 400 "Content type missing".** The usageReferences POST
  now sends its `Content-Type`
  (`application/vnd.sap.adt.repository.usageReferences.request.v1+xml`), fixing
  where-used on DDIC tables and structures. Code-object where-used was
  unaffected.

### Changed

- The outgoing request `User-Agent` product token is now `sap-adt-mcp` (was
  `claude-for-abap`), matching the project rename.

## [0.7.0]

### Changed

- **Project renamed to `sap-adt-mcp`** (GitHub repo: `yzonur/sap-adt-mcp`,
  previously `claude-for-abap`). The npm package is now published as
  `sap-adt-mcp`; the old `claude-for-abap` package is deprecated but its
  existing installs keep working. Both `sap-adt-mcp` and `claude-for-abap`
  bin names are provided. The MCP server now identifies itself as
  `sap-adt-mcp` in the initialize handshake. No tool, prompt, or config
  changes — the config still lives at `~/.sap-adt-mcp/config.json`.

## [0.6.0]

The high-priority tool backlog, in one pass — eighteen new tools across six new
modules plus extensions to discovery and quality. Every tool was developed
against the on-prem E4D test system; the notes below mark which were verified
live against real ADT responses and which are best-effort against endpoints E4D
does not expose (they ship with graceful `available:false` degradation and are
genuinely useful on systems — typically S/4HANA — that do expose them).

### Added — source & analysis

- **`adt_grep_source`** — full-text regex search across ABAP source, the missing
  half of `adt_search_objects` (which only matches names). Scope to a package
  (optionally recursive), a transport, or an explicit object list; fetches
  `/source/main` for each source-bearing object (PROG/CLAS/INTF/INCL/DDLS/DCLS/
  DDLX/BDEF) and returns matching lines as object + line + text. Bounded by
  `maxObjects`/`maxMatches` with explicit truncation flags; unreadable objects
  surface under `errors` rather than failing the run. _Verified live on E4D._
- **`adt_run_atc_package` / `adt_run_atc_transport`** — bulk ATC via the full
  worklist flow (create worklist → run → fetch results), the container-level
  counterpart to the per-object `adt_run_atc`. Returns parsed findings
  (check/message/priority/location) plus a priority histogram and the worklist
  id. `checkVariant` defaults to the system check variant read from ATC
  customizing. _Verified live on E4D (345 findings over `/FGLR/FLEET`)._
- **`adt_compare_versions`** — diff two versions of one object's source within a
  system (defaults to inactive-vs-active — "what did I change but not activate").
  Reuses the `adt_compare_source` diff engine. _Verified live on E4D._
- **`adt_list_versions`** — version-history list via `{objectUri}/versions`.
  On-prem NetWeaver does not expose this sub-resource (E4D returns 404), so the
  tool reports `available:false` with a pointer to `adt_compare_versions`. _Best-
  effort; not available on E4D._

### Added — CDS

- **`adt_cds_data_preview`** — preview a CDS view's data by entity name (no SQL),
  reusing the data-preview parser. _Route verified live on E4D; positive preview
  unverified (E4D ships no CDS content)._
- **`adt_cds_dependencies`** — CDS dependency graph via the DDL graphdata
  endpoint, with optional related-objects. _Route verified live on E4D._
- **`adt_list_released_apis`** — the API release-state contract catalog
  (C0/C1/C2/C3 …) from `informationsystem/releasestates`. _Verified live on E4D
  (12 contracts)._

### Added — situational awareness

- **`adt_list_inactive_objects`** — the "Inactive Objects" worklist (edited but
  not activated), each object paired with its transport. _Verified live on E4D._
- **`adt_list_locks`** — SM12 runtime-enqueue analog. No standardized ADT REST
  exists for runtime enqueues; reports `available:false` with a hint to SM12.
  _Best-effort; not available on E4D._

### Added — experimental (no ADT REST on E4D — ship with graceful degradation)

- **`adt_get_note` / `adt_check_note_status` / `adt_implement_note`** — SAP Note
  (Note Assistant) integration. Requires the SNOTE ADT plug-in (modern S/4HANA);
  classic NetWeaver returns `ExceptionResourceNotFound`, surfaced as
  `available:false`. `adt_implement_note` is write-gated. _Graceful path verified
  on E4D; positive paths unverified._
- **`adt_schedule_job` / `adt_read_spool`** — SM36/SP01 analogs. No standardized
  ADT background-processing API; reports `available:false` on systems without an
  extension service. _Graceful path verified on E4D._

### Added — generation

- **`adt_rap_scaffold`** — generate a full RAP stack from a short spec: CDS root
  view entity → behavior definition (managed) → behavior implementation class →
  service definition → service binding. **Defaults to `dryRun:true`** — returns
  the planned names and generated source for review without creating anything;
  `dryRun:false` creates the source-based artifacts in dependency order
  (read-only-gated, halts on first failure). The service binding is always
  plan-only (its publish step is not automated). _Generation/dry-run verified on
  E4D; write path unverified (object creation was out of scope for this pass)._

### Changed

- **Per-request timeout override.** `AdtClient.request` now accepts an optional
  `timeoutMs` to override the profile default for a single call. Bulk ATC uses a
  120 s ceiling — a whole-package run executes synchronously server-side and
  routinely exceeds the 30 s default.
- **Read-only allowlist** now permits `POST /sap/bc/adt/atc/*` (worklist analysis)
  and `POST /sap/bc/adt/datapreview/*` (SELECT/CDS preview). Both are read-only in
  spirit — they execute no object changes — and were previously blocked in
  read-only mode, which also affected the existing `adt_run_atc` and
  `adt_read_table`.
- **`object-uris.js`** gained `SRVD` (service definition) and `SRVB` (service
  binding) type mappings, used by the RAP scaffold and available to all
  URI-resolving tools.

## [0.5.5]

Four MCP-seam bugs surfaced while creating DDIC objects (`/FGLR/DM_FLTTRSCNR`,
`/FGLR/DE_FLTTRSCNR`) on on-prem E4D for the Fleet Transfer scenario refactor.
All four are input-validation / shortcut gaps that turned recoverable mistakes
into opaque crashes. Tests in `test/mcp-bug-fixes.test.js`.

### Added

- **`adt_request.contentType`** — top-level shortcut for the `Content-Type`
  header, mirroring `accept`. Folds into `headers["Content-Type"]`; an explicit
  `headers["Content-Type"]` still wins. Previously callers had to know to set
  `headers` and got a silent 415 when they reached for the obvious `contentType`
  field.

### Fixed

- **`adt_get_transport` / `adt_release_transport` crash on wrong field name.**
  Both handlers now validate `args.transport` is a non-empty string before
  calling `.toUpperCase()` and return a textResult that names the correct field
  (so callers passing `transportId` get a useful error, not
  `Cannot read properties of undefined`).
- **`adt_search_objects` 500 on systems without `quickSearch`.** Detects the
  500 body match `/No service found for ID quickSearch/i` and retries the same
  endpoint without the `operation` query (legacy informationsystem/search
  shape). Response carries `operation: "legacy"` when the fallback fires.
- **`adt_activate` opaque error on wrong argument shape.** Validates `objects`
  is a non-empty array of `{name, type}` before iterating. Callers passing the
  singular `objectName` / `objectType` shape now get a clear hint instead of
  `Cannot read properties of undefined (reading 'map')`.

## [0.5.4]

Seven bugs surfaced in one real-world ABAP refactor session against a ~147 KB
class (`/FGLR/CL_FLEET_TRANSFER`) on on-prem E4D. All sit at the MCP↔ADT seam
and were invisible to the pure-unit-test suite. Full write-up in
[docs/bugfix-2026-05-15.md](docs/bugfix-2026-05-15.md).

### Added

- **`adt_set_source_chunked`** — multi-call protocol for writing class bodies
  that exceed a single MCP tool-call payload. Caller acquires the lock with
  `adt_lock`, sends chunks under a stable `bufferId` with sequential
  `chunkIndex`, commits with `commit=true`. Server-side buffer with 10-min TTL,
  4 MB total cap, strict ordering. Partial-source guard runs at commit.
- **`adt_get_source.firstLine` / `lastLine` / `onlyMethod`** — pagination and
  method-scope slicing. Response now reports `totalLines`, `totalBytes`,
  `firstLine`, `lastLine`, `scope`, `truncated`. `onlyMethod` is case-insensitive
  and skips declarations in `CLASS … DEFINITION`.
- **`adt_set_source.acknowledgePartial`** — explicit bypass for the new
  partial-write guard (Fixed below).
- **`adt_activate.processRedoneOOSourceVersionOnly` / `preauditRequested`** —
  forwarded to ADT as `isProcessRedoneOOSourceVerOnly=true` / `preauditRequested`.
  Recovers from "Object components locked in request and separate task" 403s
  in multi-developer transports.
- **`adt_lock.transport`** — forwards as `corrNr=<TR>` to scope the lock to a
  specific transport. `adt_set_source` and `adt_delete_object` now forward
  their `transport` parameter to the LOCK call as well, not just to the
  PUT/DELETE.

### Fixed

- **`adt_set_source` partial-write guard.** PUT on ADT is atomic — it replaces
  the entire include. Previously a caller could send a chunk thinking it was a
  diff and silently delete the rest of the include. `detectPartialSource()`
  now rejects input whose first non-comment line is not a recognised
  top-level ABAP keyword (`CLASS`, `INTERFACE`, `REPORT`, `PROGRAM`,
  `FUNCTION`, `FORM`, `MODULE`, `METHOD`, `DEFINE`, `DATA`, …). Bypass with
  `acknowledgePartial: true`.
- **`parseAdtError` no longer drops CTS diagnostics.** ADT lock failures
  carry `LONGTEXT` (human-readable diagnosis) and `T100KEY-V1..V4` (the
  blocking transport's ID, owner, suggested resolution) in either
  `<entry key="…">` or `<property name="…">` shapes. Both are now extracted
  (HTML-stripped) and surfaced as `error.properties.longText` and
  `error.properties.t100.{id, number, vars}`.

### Investigated

- **Method-scope class URI does not exist.** Seven variants of
  `/sap/bc/adt/oo/classes/<class>/includes/method/<method>` all return 404 —
  SAP's ADT REST has no method-scope source endpoint. ADT in Eclipse fetches
  the full implementations include and navigates client-side. The new
  `adt_get_source.onlyMethod` parameter is the practical equivalent.

### Tests

54 new unit tests across `test/source-guard.test.js`,
`test/source-pagination.test.js`, `test/source-chunked.test.js`,
`test/lifecycle-activate.test.js`, `test/lock.test.js`, plus extensions to
`test/adt-error.test.js`. Suite at 141/141.

## [0.5.3]

Hot-fix for a CSRF handshake bug that broke every state-changing tool against
on-prem ADT. Verified against E4D.

### Fixed

- **CSRF discovery handshake no longer strips its own `Fetch` header.** The
  `PROTECTED_HEADERS` filter on `#send` (added in the adt_request security
  pass to stop callers from forging `Authorization` / `Cookie` /
  `X-CSRF-Token`) was also stripping the `X-CSRF-Token: Fetch` header that
  `#fetchCsrf` itself attaches to the discovery GET. SAP returned the
  AtomSvc service document without a token, and every write (`adt_create_object`,
  `adt_set_source`, `adt_activate`, `adt_lock`, `adt_create_transport`,
  `adt_delete_object`, `adt_release_transport`, `adt_pretty_print`, ATC runs)
  failed with `Failed to fetch CSRF token (status 200): <?xml ...>`. The fix
  routes the internal Fetch header through a separate `internalHeaders`
  channel that bypasses the filter; caller-supplied `X-CSRF-Token` from
  `adt_request` is still stripped. Two undici `MockAgent` regression tests
  pin both sides.

## [0.5.2]

Second round of dump-tool fixes. v0.5.1 fixed the network-level bugs but a
real-system test against on-prem ADT (S/4HANA E4D) showed three remaining
shape mismatches: the chapter parser couldn't read the boxed-pipe formatted
output, the metadata parser ignored root-element attributes (which is where
on-prem actually puts the dump payload), and the list response carried a
10+KB HTML summary per entry that blew past tool-output token limits.

### Fixed

- **`parseDumpChapters` now handles boxed (pipe-wrapped) dump output.**
  Formatted dumps on on-prem releases ship each line wrapped in `|content|`
  with chapter separators of `-` rules. The parser now unboxes the line
  before matching titles and skips separator runs, so chapter extraction
  works on both bare and boxed output. v0.5.1 returned `chapters: {}` for
  every real dump.
- **`parseDumpMetadata` now extracts root-element attributes.** Real
  on-prem ADT returns the dump payload as attributes on the root element
  (`title`, `error`, `terminatedProgram`, `author`, `datetime`,
  `serverInstance`, …) rather than as child elements. The parser scans the
  root, filters `xmlns` declarations, and merges the attributes into
  `fields`. The commonly-needed values (`runtimeError`, `program`, `user`,
  `time`, `server`, `title`) are also lifted to the top level of the
  response so the agent doesn't have to probe the map.
- **`adt_list_dumps` no longer ships per-entry `summary` HTML.** The summary
  on real systems is a 10+KB HTML chunk (chapter index + back-link) that on
  a 20-row list bloats responses past the tool-output token limit. Stripped
  from list responses; agents that need detail call `adt_get_dump` (which
  returns structured chapters anyway).
- **`whatCanYouDo` chapter pattern accepts variants of the subject.** Real
  dumps title the chapter "What can I do?" (first-person); the original
  pattern was anchored on "you" and the body leaked into the preceding
  `whatHappened` chapter. Pattern broadened to accept any single subject
  word so translations and phrasing variants don't desync the parser.

## [0.5.1]

Verifying v0.5.0 against a real on-prem ADT system (NetWeaver-class) exposed
three bugs and one gap in the dump tools shipped that day. All four are fixed
in this patch; no behavior changes elsewhere.

### Fixed

- **`adt_list_dumps` Accept header**. The feed endpoint requires
  `application/atom+xml;type=feed` and rejects bare `application/atom+xml`
  with HTTP 406. Tool now sends the correct media type.
- **`adt_list_dumps` parser missed namespace-prefixed Atom tags**. Real SAP
  feeds tag elements with the `atom:` prefix (`<atom:entry>`, `<atom:id>`,
  `<atom:author>`). The list call returned `count: 0` against a feed of 245
  entries. Parser regex now accepts both prefixed and unprefixed forms.
- **`adt_list_dumps` exposed `runtimeError` and `program`**. Real feeds carry
  the runtime error name and terminated program in `<atom:category>`
  elements, not `<atom:title>`. The parser now extracts both; if `<title>` is
  absent it falls back to the runtime error name.
- **`adt_list_dumps` trims client-side**. The server-side `maxResults`
  parameter is ignored on at least some releases (`maxResults=100` returned
  245 rows). Tool now caps the response client-side after parsing and reports
  `totalReturnedByServer` so the truncation is visible.
- **`adt_get_dump` was completely broken**. Three problems: wrong path
  (`runtime/dumps/<id>` vs the singular `runtime/dump/<id>` the feed's
  self-link advertises), double URL-encoding (feed ids arrive already
  encoded), and wrong Accept header (`application/xml` → 406, real media
  type is `application/vnd.sap.adt.runtime.dump.v1+xml`). The tool now does
  a two-step fetch: a metadata XML lookup followed by a GET on the
  `<dump:link relation="contents">` sub-resource to retrieve the formatted
  dump text.

### Added

- **`adt_get_dump` chapter extraction**. The formatted dump text is parsed
  into a chapter map (shortText, whatHappened, errorAnalysis, howToCorrect,
  whereTerminated, sourceCodeExtract, …). By default the response returns
  only the six critical chapters; pass `chapters: [...]` to pick specific
  ones or `full: true` to also include the raw text (typically 100KB+).
  `chaptersAvailable` lists every chapter the parser recognized.

## [0.5.0]

### Added

- **`adt_list_dumps` / `adt_get_dump`** — ST22 runtime errors are now first-class.
  `list_dumps` queries `/sap/bc/adt/runtime/dumps` with optional `user`, `host`,
  `from` / `to`, and `maxResults` filters; the response Atom feed is parsed into
  structured entries with their release-specific `rba:*` fields surfaced as a
  map (host, program, include, line, errorClass, …). `get_dump` fetches the
  full detail by id. Falls back to raw XML on parse failure so the agent can
  still reason about niche dump shapes.
- **`adt_read_table`** — SE16-style table reads via the ADT Data Preview API
  (`/sap/bc/adt/datapreview/freestyle`). OpenSQL SELECT in, structured
  `{ columns, rows }` out. Client-side SELECT-only guard + per-call row cap
  (default 100, hard cap 5000); the SAP endpoint enforces read-only on its
  side too. Requires NetWeaver 7.55+ / S/4HANA — older systems may not
  expose the endpoint.

### Changed

- **Modular tool layout.** `src/server.js` shrank from 1636 lines to ~190 and
  is now a thin dispatcher; each tool category lives in its own module under
  `src/tools/` (`connection`, `source`, `quality`, `lifecycle`, `discovery`,
  `cross-system`, `transports`, `runtime`, `data`, `request`). Shared helpers
  moved into `src/result.js`, `src/lock.js`, and `src/xml.js`. New tool
  modules follow the contract `export const tools` + `export function register(ctx)`,
  validated by `test/tools-shape.test.js`. No behavior changes for existing
  tools — every previous test still passes.

## [0.4.0]

### Added

- **Five Clean Core MCP prompts** — user-invokable slash commands that
  encode SAP's Clean Core extensibility framework and pair it with the
  `adt_*` tools so the model can act on real systems. None auto-fires;
  every prompt includes an applicability check that backs off on ECC and
  falls back to classic-ABAP idioms.
  - `clean_core_grade` — grade one object A/B/C/D, with refactor sketch
  - `clean_core_review` — package-wide KPIs (Clean Core Share, Tech Debt
    Score, top Level D offenders)
  - `clean_core_refactor` — mode-loading; loads wrapper / released-CDS /
    BAdI patterns
  - `clean_core_create` — mode-loading; defaults new objects to Level A
    (ABAP Cloud, RAP, business object interfaces)
  - `clean_core_design` — mode-loading; fit-to-standard + 3-phase
    methodology + on-stack vs side-by-side, no code writes
- **`skills/abap-clean-core/`** — long-form Clean Core reference shipped
  alongside the MCP. Five files (`SKILL.md` plus four deep-dives in
  `references/`): A/B/C/D level deep-dive, ABAP Cloud allowed/forbidden
  lists, the SAP Application Extension Methodology in detail, governance
  & KPI calculations. Optional install as an auto-loading Claude skill;
  the default repo behavior is prompt-only opt-in.

### Security

- **Path-traversal bypass of `readOnly`** (CRITICAL) — `isReadOnlyPostPath`
  ran `startsWith` on the raw path; `new URL()` later collapsed `../`
  segments, letting a write request smuggle in under a read-only
  allowlist entry. Fixed: path is now URL-normalized before the
  read-only check, and the same canonical path is used for the actual
  request.
- **`adt_request` confused-deputy** (CRITICAL) — the escape hatch
  accepted any path. The configured SAP credentials could be used
  against `/sap/opu/odata/...`, `/sap/bc/soap/rfc`, or any other ICF
  service. Fixed: paths are normalized and rejected if they don't sit
  under `/sap/bc/adt/`.
- **`Authorization` / `Cookie` / `X-CSRF-Token` override via
  `extraHeaders`** (HIGH) — caller-supplied headers were applied after
  the client-owned auth headers and overwrote them. Fixed: a
  `PROTECTED_HEADERS` allowlist drops these three before they reach
  `Headers.set`.
- **`adt_transport_diff` URI injection** (HIGH) — SAP-returned object
  URIs were used verbatim as the request path against both diff
  systems; a malicious entry with `../../../sap/bc/soap/rfc?...` could
  redirect the diff to non-ADT endpoints. Fixed: URIs are normalized
  and skipped (status `rejected-non-adt-uri`) if they don't resolve
  under `/sap/bc/adt/`.
- **`programType` XML attribute injection** (HIGH) in
  `adt_create_object` for programs — the field was concatenated into
  the XML body without escaping or validation, letting a caller close
  the attribute and inject elements (e.g., a second `packageRef`
  pointing at a different package). Fixed: validated against the
  SAP-published set (`executableProgram`, `modulePool`,
  `subroutinePool`, `functionGroup`, `interfacePool`, `classPool`,
  `typeGroup`, `include`) and run through `escapeXml` at the call site.

All five fixes have regression tests in `test/security.test.js`.

### Changed

- **Node.js minimum bumped to 22.19+.** The `undici@^8` dep already
  required Node 22.19+ in practice; the previous `engines.node: ">=18.17"`
  claim was unenforceable (any user on Node 18 or 20 would crash on the
  first ADT call). CI matrix moved from `[18, 20, 22]` to `[22, 24]`.

## [0.3.0]

### Added

- `adt_create_object` — create programs, classes, interfaces, includes,
  function groups, function modules, CDS views, access controls, metadata
  extensions, behavior definitions, and message classes from a single tool
  call. Returns the new object URI; pair with `adt_set_source` and
  `adt_activate` for end-to-end scaffolding.
- `adt_delete_object` — lock + DELETE + (no unlock needed) for any supported
  object type.
- `adt_lock` / `adt_unlock` — primitives so agents can keep an object locked
  across multiple writes within a single turn.
- `adt_set_source` accepts an optional `lockHandle` parameter to reuse an
  externally-acquired lock.
- New example workflow: scaffold a class from spec.

### Changed

- Lock acquisition / release factored into shared `acquireLock` / `releaseLock`
  helpers used by `set_source`, `delete_object`, and the new lock primitives.

## [0.2.0] — initial public preview

### Added

- High-level tools that hide ADT URI conventions from the agent:
  - `adt_get_source` — fetch source by object name + type alias
  - `adt_set_source` — orchestrates lock → PUT → unlock
  - `adt_activate` — activate one or more objects
  - `adt_syntax_check` — run the ADT syntax checker
  - `adt_search_objects` — repository quick-search
  - `adt_where_used` — usage references
  - `adt_browse_package` / `adt_list_packages` — package tree exploration
  - `adt_compare_source` — cross-system unified diff
  - `adt_list_transports` / `adt_get_transport` / `adt_create_transport` /
    `adt_release_transport` — TR management
  - `adt_transport_diff` — diff every object in a TR between two systems
  - `adt_pretty_print` — server-side ABAP pretty printer
  - `adt_run_unit_tests` — ABAP Unit runner
  - `adt_run_atc` — ABAP Test Cockpit runner
- `readOnly` config flag (global and per-system) blocks unsafe HTTP methods
  while still allowing ADT's read-only POST queries.
- Structured ADT error parsing (`<exc:exception>` → `{ type, message, namespace }`).
- CDS / RAP / DDIC type support: DDLS, DCLS, DDLX, BDEF, MSAG.
- `parseObjectReferences` helper used by search / where-used / transport-diff
  to surface results as structured JSON.
- CLI flags: `--help`, `--version`, `--validate-config`.
- `SAP_ADT_MCP_DEBUG=1` env var traces every request/response to stderr.
- Per-request timeout (default 30s, configurable per-system via `timeoutMs`).
- Test suite using `node:test` (no extra dependencies).
- ESLint flat config + GitHub Actions CI matrix (Node 18 / 20 / 22).

### Changed

- Package renamed to `claude-for-abap`. Old `sap-adt-mcp` bin name is kept as
  an alias.
- README, examples, and config samples generic-ised — no more hard-coded
  customer hostnames or paths.
