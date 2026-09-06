# sap-adt-mcp — backlog

Feature ideas surfaced during the v0.5 design discussion (2026-05-13). Sections
follow priority. The SessionStart hook (`~/.claude/show-active-todos.ps1`)
surfaces any `### ` section that still has unchecked items at the top of the
next session, so keep section headings stable and check items off as they
land — don't rewrite the file structure unless you mean to.

### MCP tool bug fixes — discovered & fixed 2026-05-15

Bugs surfaced while working with `/FGLR/CL_FLEET_TRANSFER` (~147 KB class) against
the E4D test system. All seven verified against current code and resolved.

- [x] **Bug 3 — `adt_set_source` partial-write guard.** Added `detectPartialSource()` in `src/tools/source.js` plus `acknowledgePartial` bypass flag. Tool description now warns about atomic replace. Unit tests in `test/source-guard.test.js`.
- [x] **Bug 5 — `adt_lock` strips LONGTEXT + T100KEY from CTS errors.** `parseAdtError` in `src/adt-error.js` now extracts `<entry key="LONGTEXT">` / `<property name="LONGTEXT">` (HTML-stripped) plus `T100KEY-ID/NO/V1..V4`. Surfaced as `error.properties.longText` / `error.properties.t100`. Tests in `test/adt-error.test.js`.
- [x] **Bug 6 — `adt_lock` doesn't accept `corrNr`.** `adt_lock` schema now exposes `transport`. `acquireLock(client, path, options)` accepts `{ accessMode, corrNr }` (string second arg still works). `adt_set_source` and `adt_delete_object` also forward `transport` to the LOCK call for symmetry. Tests in `test/lock.test.js`.
- [x] **Bug 2 — `adt_activate` missing `processRedoneOOSourceVersionOnly`.** Schema now exposes `processRedoneOOSourceVersionOnly` (→ `isProcessRedoneOOSourceVerOnly=true` on query) and `preauditRequested` override. Tests in `test/lifecycle-activate.test.js`.
- [x] **Bug 4 — `adt_get_source` has no pagination.** Added `firstLine` / `lastLine` (clamped to source bounds) and `onlyMethod` parameters. Response now includes `totalLines`, `totalBytes`, `firstLine`, `lastLine`, `scope`, `truncated`. Tests in `test/source-pagination.test.js`.
- [x] **Bug 1 — `adt_set_source` body cap blocks large classes.** Added `adt_set_source_chunked` tool: caller acquires lock with `adt_lock`, sends chunks with stable `bufferId` + sequential `chunkIndex`, commits with `commit=true`. Server-side buffer with 10-min TTL, 4 MB cap, out-of-order rejection, partial-source guard at commit. Tests in `test/source-chunked.test.js`.
- [x] **Bug 7 — method-level class URI.** Investigation: SAP backend does not expose a method-scope source endpoint — ADT Eclipse fetches the full implementations include and navigates client-side. The `onlyMethod` parameter on `adt_get_source` (added by Bug 4) is the practical equivalent: server fetches the include, slices the METHOD … ENDMETHOD block client-side and returns just that slice with line metadata.

### MCP tool bugs — discovered & fixed 2026-05-22

Surfaced while creating DDIC domain + DE (`/FGLR/DM_FLTTRSCNR`, `/FGLR/DE_FLTTRSCNR`) on E4D for Fleet Transfer scenario refactor. All four resolved; tests in `test/mcp-bug-fixes.test.js`.

- [x] **`adt_request` silently drops `contentType` parameter.** Added top-level `contentType` shortcut in `src/tools/request.js` mirroring `accept`. Handler folds it into `headers["Content-Type"]`; an explicit `headers["Content-Type"]` still wins.
- [x] **`adt_get_transport` crashes on the `transportId` parameter.** `src/tools/transports.js` now validates `args.transport` before `.toUpperCase()` and returns a textResult error pointing out the correct field name. Same guard added to `adt_release_transport`.
- [x] **`adt_search_objects` returns 500 "No service found for ID quickSearch" on E4D.** `src/tools/discovery.js` now detects the 500 body match `/No service found for ID quickSearch/i` and retries the same endpoint without the `operation` query (legacy informationsystem/search shape). Response carries `operation: "legacy"` so the caller can tell the fallback fired.
- [x] **`adt_activate` schema error message is opaque.** `src/tools/lifecycle.js` validates `objects` is a non-empty array of `{name, type}` before iterating and returns a friendly textResult — including a hint about the wrong singular `objectName`/`objectType` shape.

### Tool additions — high priority

_All shipped in v0.6.0 — released to GitHub (tag v0.6.0) and published to npm on
2026-06-02. Endpoints absent on the E4D test system (SNOTE, SM12 locks,
jobs/spool) ship as best-effort with graceful `available:false` degradation —
useful on S/4 systems that expose them, unverified there. See CHANGELOG 0.6.0
for the per-tool live-verified vs best-effort breakdown._

- [x] `adt_grep_source` — full-text source search (regex) scoped to package / TR / system. _Verified live on E4D._
- [x] `adt_list_versions` + `adt_compare_versions` — ADT versions API. compare = inactive-vs-active source diff (_verified live_); list = graceful `available:false` (no `/versions` REST on E4D).
- [x] `adt_run_atc_package` / `adt_run_atc_transport` — bulk ATC by container via the full worklist flow. _Verified live on E4D (345 findings)._
- [x] `adt_get_note` + `adt_implement_note` + `adt_check_note_status` — SAP Note (SNOTE) integration. _Best-effort; needs the SNOTE ADT plug-in (S/4), absent on E4D._
- [x] `adt_cds_dependencies` + `adt_cds_data_preview` + `adt_list_released_apis` — CDS tooling. released-APIs + dependency/preview routes _verified live on E4D_ (positive preview needs CDS content E4D lacks).
- [x] `adt_list_locks` (SM12 analog) + `adt_list_inactive_objects` — inactive-objects _verified live_; SM12 locks graceful `available:false` (no enqueue REST on E4D).
- [x] `adt_schedule_job` + `adt_read_spool` — background job submit + spool read. _Best-effort; no ADT background-processing REST on E4D._
- [x] `adt_rap_scaffold` — generate a full RAP stack (CDS + behavior def + impl class + service def + service binding) from a spec. Defaults to `dryRun:true`. _Generation verified live; write path unverified (creation out of scope this pass)._

### Tool additions — nice-to-have

- [ ] `adt_value_help` — F4 / domain fixed values / check-table contents.
- [ ] `adt_auth_check` — SU24 auth objects required by a transaction / object.
- [ ] Code-intelligence pack — method-level call hierarchy, interface implementations, redefined methods, type hierarchy. `adt_where_used` is the broad sweep; agent needs the surgical version.
- [ ] `adt_translations` — long texts for messages / classes (SE63 lite).
- [x] `adt_system_info` — SAP_BASIS release/ext. release + S/4 vs ECC (via `CVERS`), shipped in [Unreleased]. SP level and ABAP Cloud availability are not covered — `CVERS` doesn't carry SP level and ABAP Cloud/Steampunk needs a separate check.
- [ ] `adt_transport_queue` — STMS import buffer status. "Where is TR X right now — DEV, in QAS buffer, imported into PRD?"
- [ ] `adt_compare_ddic` — DDIC metadata diff (fields, indexes, foreign keys, technical settings). Today only source can be compared cross-system; for tables that's not enough.

### Cloud connectivity — S/4HANA Public Cloud / BTP (SAML / OAuth)

Need: the MCP only speaks Basic auth, so it can't reach SSO/SAML-protected
S/4HANA Cloud Public Edition (and BTP ABAP env) systems. A developer contributed
a working reference (browser-SSO cookie capture). **Status: under evaluation,
not started — discuss before building.**

Auth-method analysis (no single method is universal):

- **OAuth bearer / service key** — cleanest & headless, but needs the tenant to
  expose an OAuth client / service key (admin-provisioned; common on BTP ABAP
  env / Steampunk, often not self-service for S/4HC Public ADT).
- **Communication user (Basic)** — does *not* cover the ADT developer surface
  (comm scenarios are for specific OData/SOAP APIs), so not usable for our case.
- **Browser SSO cookie capture** — the only method that works for *any* user who
  can log in interactively, with zero backend setup. Downsides: heavy browser
  dep (Playwright/Puppeteer, hundreds of MB), short session life (frequent
  re-login), live session cookies on disk (bearer credential), capture fragility.

Proposed shape (decided direction, not yet built):
- [ ] Shared cloud auth layer: in SAML/cloud mode skip `Authorization` + `sap-client`
  header, send `x-sap-adt-sessiontype: stateful`; CSRF from
  `/sap/bc/adt/compatibility/graph` (not `/discovery`); force-refresh CSRF on 403.
- [ ] Credential source A — **Bearer token** (service key / OAuth): tiny change,
  headless, refreshable. For tenants that expose it.
- [ ] Credential source C — **captured cookie file** consumption in the lean core
  (load JSON → cookie map; our name-keyed Map already avoids the Python
  `CookieConflictError`). Universal fallback.
- [ ] Browser capture (Phase 1) kept **optional / separate helper**, never a core
  dependency, so non-cloud installs stay lean.
- [ ] Security: cookie/token file is a bearer credential — gitignore, restricted
  perms, redact from crash reporter; also stop the DEBUG trace from printing the
  `Cookie` header (currently only `Authorization` is skipped).
- [ ] Note for users: cloud development is ABAP Cloud / Clean Core (restricted
  language, released APIs only, customer namespace) — the connection works like
  on-prem but the platform itself limits what can be done.

### Structural improvements

- [ ] MCP `resources` registration — expose the system list, open TRs, recent dumps as live resources so an agent can see them without burning a tool call.
- [ ] Integration tests with an undici interceptor — happy/error paths for CSRF retry, read-only enforcement, lock orchestration. All current tests are pure-unit; the wire layer is unverified.
- [ ] Read-only result cache (30 s – 2 min TTL) for repeated calls in a single agent session. `list_packages`, `search_objects`, `list_systems` are the obvious wins.
- [ ] Cost / token awareness — soft output caps for large lists, "top N + summary" mode, opt-in `full=true`. A reckless `list_packages` against a big root currently floods context.
- [ ] ECC-specific prompt set — `classic-abap-review`, `modification-audit`, `user-exit-finder`. Clean Core prompts are S/4-only and ECC shops get less day-one value than they could.
### MCP tool bugs — discovered & fixed 2026-06-10

Three content-negotiation defects surfaced in field use across E4D and USD, each
reported several times. In every case the tool reached the right endpoint but
sent a missing/wrong HTTP header and lost on content negotiation. All three
resolved; regression tests in `test/mcp-bug-fixes.test.js`.

- [x] **`adt_search_objects` — 400 "Parameter ris_request_type could not be found".** The quick-search POST routed to the RIS object-search handler, which demands a `ris_request_type` query param the tool never supplied. `src/tools/discovery.js` now issues quickSearch as a **GET** (the ADT Eclipse contract), which needs no such param. Namespace / wildcard / plain-name searches work again on E4D and USD. The legacy operation-less fallback is preserved.
- [x] **`adt_read_table` — 406 ExceptionResourceNotAcceptable.** Every row-returning SELECT 406'd because the Data Preview POST sent `Accept: application/xml`. `src/tools/data.js` now sends `Accept: application/vnd.sap.adt.datapreview.table.v1+xml` — the only media type the endpoint serializes a result set as. (Column/syntax errors still surface as 400, so the endpoint was always reached.)
- [x] **`adt_where_used` — 400 "Content type missing".** Where-used on DDIC tables / structures failed because the usageReferences POST carried no `Content-Type`. `src/tools/discovery.js` now sends `Content-Type: application/vnd.sap.adt.repository.usageReferences.request.v1+xml`. Fixes both DDIC structures and transparent tables; code-object where-used was unaffected.
