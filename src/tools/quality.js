import { objectUri, sourceUri, normalizeType } from "../object-uris.js";
import { escapeXml } from "../xml.js";
import { parseObjectReferences } from "../object-references.js";
import { toContextUri, deriveMainProgram } from "../main-programs.js";
import { errorResult, jsonResult, textResult } from "../result.js";
import { OBJECT_TYPE_HINT, SYSTEM_HINT } from "./_shared.js";

// Guard the `objects` array before the handlers iterate it. Callers frequently
// reach for the singular `object`/`type` shape (as adt_get_source uses), which
// left `args.objects` undefined and crashed on `.map`. Return a clean tool
// error pointing at the right shape instead of throwing.
function validateObjects(tool, objects) {
  if (!Array.isArray(objects) || objects.length === 0) {
    return textResult(
      `${tool}: \`objects\` is required — a non-empty array of { name, type[, group] }. ` +
        "Note the plural: pass `objects: [{ name: '…', type: '…' }]`, not a singular `object`/`type`.",
      true
    );
  }
  for (let i = 0; i < objects.length; i++) {
    const o = objects[i];
    if (!o || typeof o.name !== "string" || typeof o.type !== "string") {
      return textResult(
        `${tool}: objects[${i}] must be { name: string, type: string }.`,
        true
      );
    }
  }
  return null;
}

// Parse <atcfinding .../> elements from an ATC worklist result. Attribute names
// vary slightly across releases — collect them all, normalized without prefix.
const FINDING_RE = /<(?:atcfinding|atcworklist:finding|finding)\b([\s\S]*?)(?:\/>|>)/gi;
const FATTR_RE = /([\w:.-]+)\s*=\s*"([^"]*)"/g;

export function parseAtcFindings(xml) {
  if (typeof xml !== "string") return [];
  const out = [];
  for (const m of xml.matchAll(FINDING_RE)) {
    const attrs = {};
    for (const a of m[1].matchAll(FATTR_RE)) {
      if (a[1].startsWith("xmlns")) continue; // skip namespace declarations
      attrs[a[1].replace(/^[\w]+:/, "")] = a[2];
    }
    // Skip the container element if it has no finding-like attributes.
    if (attrs.checkId || attrs.messageId || attrs.priority || attrs.checkTitle) {
      out.push(attrs);
    }
  }
  return out;
}

function summarizeFindings(findings) {
  const byPriority = {};
  for (const f of findings) {
    const p = f.priority ?? "?";
    byPriority[p] = (byPriority[p] ?? 0) + 1;
  }
  return byPriority;
}

// Read the system default check variant from ATC customizing, used when the
// caller doesn't pass an explicit checkVariant.
async function fetchSystemCheckVariant(client) {
  const res = await client.request({ path: "/sap/bc/adt/atc/customizing" });
  if (!res.ok) return null;
  const text = await res.text();
  const m = text.match(/systemCheckVariant"\s+value="([^"]+)"/);
  return m ? m[1] : null;
}

// Build the <atc:run> object-set body for one or more object URIs.
function buildAtcObjectSet(uris, maxResults) {
  const refs = uris
    .map((u) => `<adtcore:objectReference adtcore:uri="${escapeXml(u)}"/>`)
    .join("");
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<atc:run xmlns:atc="http://www.sap.com/adt/atc" xmlns:adtcore="http://www.sap.com/adt/core" maximumVerdicts="${maxResults}">` +
    `<objectSets><objectSet kind="inclusive"><adtcore:objectReferences>${refs}</adtcore:objectReferences></objectSet></objectSets>` +
    `</atc:run>`
  );
}

// ATC over a whole package/transport can run well past the default 30s request
// timeout (the run executes synchronously server-side). Give the run + result
// fetch a generous ceiling.
const ATC_RUN_TIMEOUT_MS = 120_000;

// Full ATC flow: resolve variant → create worklist → run → fetch results.
async function runAtcWorklist(client, sys, { uris, checkVariant, maxResults }) {
  let variant = checkVariant;
  if (!variant) {
    variant = await fetchSystemCheckVariant(client);
    if (!variant) {
      return {
        error: errorResult(
          sys,
          400,
          "No checkVariant supplied and the system default check variant could not be read from /sap/bc/adt/atc/customizing. Pass checkVariant explicitly.",
          "text/plain",
          { stage: "variant" },
        ),
      };
    }
  }

  // 1) Create worklist — response body is the worklist id (plain text).
  const wlRes = await client.request({
    method: "POST",
    path: "/sap/bc/adt/atc/worklists",
    query: { checkVariant: variant },
    accept: "text/plain",
  });
  const wlText = await wlRes.text();
  if (!wlRes.ok) {
    return { error: errorResult(sys, wlRes.status, wlText, wlRes.headers.get("content-type"), { stage: "create-worklist", checkVariant: variant }) };
  }
  const worklistId = wlText.trim();

  // 2) Run the checks for the object set.
  const body = buildAtcObjectSet(uris, maxResults);
  const runRes = await client.request({
    method: "POST",
    path: "/sap/bc/adt/atc/runs",
    query: { worklistId },
    headers: { "Content-Type": "application/xml" },
    body,
    timeoutMs: ATC_RUN_TIMEOUT_MS,
  });
  const runText = await runRes.text();
  if (!runRes.ok) {
    return { error: errorResult(sys, runRes.status, runText, runRes.headers.get("content-type"), { stage: "run", worklistId, checkVariant: variant }) };
  }

  // 3) Fetch the worklist results.
  const resultRes = await client.request({
    path: `/sap/bc/adt/atc/worklists/${encodeURIComponent(worklistId)}`,
    query: { includeExemptedFindings: "false" },
    accept: "application/atc.worklist.v1+xml",
    timeoutMs: ATC_RUN_TIMEOUT_MS,
  });
  const resultText = await resultRes.text();
  if (!resultRes.ok) {
    return { error: errorResult(sys, resultRes.status, resultText, resultRes.headers.get("content-type"), { stage: "fetch-results", worklistId, checkVariant: variant }) };
  }

  const findings = parseAtcFindings(resultText);
  return {
    worklistId,
    checkVariant: variant,
    runResponse: runText,
    findings,
    resultXml: resultText,
  };
}

// Include-context helpers live in ../main-programs.js — adt_activate needs the
// same resolution (#113). Re-exported so the historical import path keeps
// working for callers and tests.
export { toContextUri };

export const tools = [
  {
    name: "adt_syntax_check",
    description:
      "Run an ADT syntax check on an object. Returns the raw <chkrun:reports> XML. Includes only compile in the context of a main program: for type=include, pass `context` (the main program / function group), otherwise the check returns status='notProcessed'. When omitted for an include, the tool tries to auto-resolve the include's first main program.",
    inputSchema: {
      type: "object",
      properties: {
        system: { type: "string", description: SYSTEM_HINT },
        object: { type: "string", description: "Object name." },
        type: { type: "string", description: OBJECT_TYPE_HINT },
        group: { type: "string", description: "Function group (for FUGR/FF or FUGR/I)." },
        context: {
          type: "string",
          description:
            "Main-program context for checking an include. Either a full ADT object URI (e.g. '/sap/bc/adt/functions/groups/v61a' or '/sap/bc/adt/programs/programs/zmain') or a bare program name. Only used for includes; auto-resolved from the include's main programs when omitted.",
        },
      },
      required: ["object", "type"],
    },
  },
  {
    name: "adt_run_unit_tests",
    description:
      "Run ABAP Unit tests for one or more objects (typically test container classes).",
    inputSchema: {
      type: "object",
      properties: {
        system: { type: "string", description: SYSTEM_HINT },
        objects: {
          type: "array",
          description: "Objects to test.",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              type: { type: "string", description: OBJECT_TYPE_HINT },
              group: { type: "string" },
            },
            required: ["name", "type"],
          },
        },
      },
      required: ["objects"],
    },
  },
  {
    name: "adt_run_atc",
    description:
      "Run ABAP Test Cockpit (ATC) on one or more objects. ATC endpoint shape varies across NetWeaver releases.",
    inputSchema: {
      type: "object",
      properties: {
        system: { type: "string", description: SYSTEM_HINT },
        objects: {
          type: "array",
          description: "Objects to check.",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              type: { type: "string", description: OBJECT_TYPE_HINT },
              group: { type: "string" },
            },
            required: ["name", "type"],
          },
        },
        checkVariant: {
          type: "string",
          description: "ATC check variant. Defaults to DEFAULT.",
        },
      },
      required: ["objects"],
    },
  },
  {
    name: "adt_run_atc_package",
    description:
      "Run ABAP Test Cockpit (ATC) over an ENTIRE package via the full ADT worklist flow (create worklist → run → fetch results). Returns parsed findings (check, message, priority, location) plus a priority histogram and the worklist id. When checkVariant is omitted, the system default check variant from ATC customizing is used. This is the bulk counterpart to adt_run_atc (single object).",
    inputSchema: {
      type: "object",
      properties: {
        system: { type: "string", description: SYSTEM_HINT },
        package: { type: "string", description: "Package name to check, e.g. 'ZFLEET' or '/FGLR/CORE'." },
        checkVariant: {
          type: "string",
          description: "ATC check variant. Omit to use the system default (from ATC customizing).",
        },
        maxResults: {
          type: "integer",
          description: "Maximum findings (maximumVerdicts) to request (default 100).",
          minimum: 1,
          maximum: 10000,
        },
      },
      required: ["package"],
    },
  },
  {
    name: "adt_run_atc_transport",
    description:
      "Run ABAP Test Cockpit (ATC) over every object in a transport request via the full ADT worklist flow. Resolves the transport's object references, runs ATC against them, and returns parsed findings + priority histogram + worklist id. When checkVariant is omitted, the system default check variant is used.",
    inputSchema: {
      type: "object",
      properties: {
        system: { type: "string", description: SYSTEM_HINT },
        transport: { type: "string", description: "Transport request ID, e.g. 'E4DK900123'." },
        checkVariant: {
          type: "string",
          description: "ATC check variant. Omit to use the system default.",
        },
        maxObjects: {
          type: "integer",
          description: "Maximum transport objects to include (default 200).",
          minimum: 1,
          maximum: 2000,
        },
        maxResults: {
          type: "integer",
          description: "Maximum findings (maximumVerdicts) to request (default 100).",
          minimum: 1,
          maximum: 10000,
        },
      },
      required: ["transport"],
    },
  },
];

export function register({ getClient }) {
  return {
    adt_syntax_check: async (args) => {
      const { client, name: sys } = getClient(args.system);
      const t = normalizeType(args.type);
      const isInclude = t === "INCL" || t === "FUGR/I";

      let checkUri = objectUri({
        type: args.type,
        name: args.object,
        group: args.group,
      });
      let contextUri;
      if (isInclude) {
        contextUri = args.context
          ? toContextUri(args.context)
          : await deriveMainProgram(client, checkUri);
        // Includes are checked through their source URI with the main program
        // attached as ?context= (the form ADT itself uses in include links).
        const incSource = sourceUri({
          type: args.type,
          name: args.object,
          group: args.group,
        });
        checkUri = contextUri
          ? `${incSource}?context=${encodeURIComponent(contextUri)}`
          : incSource;
      }

      const body =
        `<?xml version="1.0" encoding="UTF-8"?>` +
        `<chkrun:checkObjectList xmlns:chkrun="http://www.sap.com/adt/checkrun" xmlns:adtcore="http://www.sap.com/adt/core">` +
        `<chkrun:checkObject adtcore:uri="${escapeXml(checkUri)}"/>` +
        `</chkrun:checkObjectList>`;
      const res = await client.request({
        method: "POST",
        path: "/sap/bc/adt/checkruns",
        query: { reporters: "abapCheckRun" },
        headers: { "Content-Type": "application/vnd.sap.adt.checkobjects+xml" },
        body,
      });
      const text = await res.text();
      if (!res.ok) return errorResult(sys, res.status, text, res.headers.get("content-type"));
      const notProcessed = /chkrun:status="notProcessed"/i.test(text);
      return jsonResult({
        system: sys,
        object: args.object,
        context: contextUri,
        result: text,
        ...(isInclude && notProcessed
          ? {
              hint:
                "Include not processed — no main-program context resolved. Pass `context` " +
                "(the main program / function group ADT URI, e.g. '/sap/bc/adt/programs/programs/zmain').",
            }
          : {}),
      });
    },

    adt_run_unit_tests: async (args) => {
      const objectsError = validateObjects("adt_run_unit_tests", args.objects);
      if (objectsError) return objectsError;
      const { client, name: sys } = getClient(args.system);
      const refs = args.objects
        .map((o) => {
          const uri = objectUri({ type: o.type, name: o.name, group: o.group });
          return `<adtcore:objectReference adtcore:uri="${escapeXml(uri)}"/>`;
        })
        .join("");
      const body =
        `<?xml version="1.0" encoding="UTF-8"?>` +
        `<aunit:runConfiguration xmlns:aunit="http://www.sap.com/adt/aunit" xmlns:adtcore="http://www.sap.com/adt/core">` +
        `<adtcore:objectSets><adtcore:objectSet kind="inclusive">${refs}</adtcore:objectSet></adtcore:objectSets>` +
        `</aunit:runConfiguration>`;
      const res = await client.request({
        method: "POST",
        path: "/sap/bc/adt/abapunit/testruns",
        headers: {
          "Content-Type": "application/vnd.sap.adt.abapunit.testruns.config.v1+xml",
        },
        body,
      });
      const text = await res.text();
      if (!res.ok) return errorResult(sys, res.status, text, res.headers.get("content-type"));
      return jsonResult({ system: sys, result: text });
    },

    adt_run_atc: async (args) => {
      const objectsError = validateObjects("adt_run_atc", args.objects);
      if (objectsError) return objectsError;
      const { client, name: sys } = getClient(args.system);
      const refs = args.objects
        .map((o) => {
          const uri = objectUri({ type: o.type, name: o.name, group: o.group });
          return `<adtcore:objectReference adtcore:uri="${escapeXml(uri)}"/>`;
        })
        .join("");
      const variant = args.checkVariant ?? "DEFAULT";
      const body =
        `<?xml version="1.0" encoding="UTF-8"?>` +
        `<atc:run xmlns:atc="http://www.sap.com/adt/atc" xmlns:adtcore="http://www.sap.com/adt/core" atc:checkVariant="${escapeXml(variant)}">` +
        `<objectSets><objectSet kind="inclusive">${refs}</objectSet></objectSets>` +
        `</atc:run>`;
      const res = await client.request({
        method: "POST",
        path: "/sap/bc/adt/atc/runs",
        headers: { "Content-Type": "application/xml" },
        body,
      });
      const text = await res.text();
      if (!res.ok) return errorResult(sys, res.status, text, res.headers.get("content-type"));
      return jsonResult({
        system: sys,
        checkVariant: variant,
        result: text,
        note: "ATC results are typically retrieved by following the worklist URL inside the response. Use adt_request to fetch the worklist if needed.",
      });
    },

    adt_run_atc_package: async (args) => {
      const { client, name: sys } = getClient(args.system);
      const pkgUri = `/sap/bc/adt/packages/${encodeURIComponent(args.package.toLowerCase())}`;
      const r = await runAtcWorklist(client, sys, {
        uris: [pkgUri],
        checkVariant: args.checkVariant,
        maxResults: args.maxResults ?? 100,
      });
      if (r.error) return r.error;
      return jsonResult({
        system: sys,
        scope: `package:${args.package.toUpperCase()}`,
        checkVariant: r.checkVariant,
        worklistId: r.worklistId,
        findingCount: r.findings.length,
        byPriority: summarizeFindings(r.findings),
        findings: r.findings,
        raw: r.findings.length === 0 ? r.resultXml.slice(0, 4000) : undefined,
      });
    },

    adt_run_atc_transport: async (args) => {
      const { client, name: sys } = getClient(args.system);
      const trId = args.transport.toUpperCase();
      const maxObjects = args.maxObjects ?? 200;

      const trRes = await client.request({
        path: `/sap/bc/adt/cts/transportrequests/${encodeURIComponent(trId)}`,
      });
      const trBody = await trRes.text();
      if (!trRes.ok) {
        return errorResult(sys, trRes.status, trBody, trRes.headers.get("content-type"), {
          stage: "fetch-transport",
        });
      }
      const refs = parseObjectReferences(trBody)
        .filter((ref) => ref.uri)
        .slice(0, maxObjects);
      if (refs.length === 0) {
        return jsonResult({
          system: sys,
          scope: `transport:${trId}`,
          objectCount: 0,
          note: "No object references found in the transport — nothing to check.",
          raw: trBody.slice(0, 2000),
        });
      }
      const uris = refs.map((ref) => ref.uri.split("?")[0]);
      const r = await runAtcWorklist(client, sys, {
        uris,
        checkVariant: args.checkVariant,
        maxResults: args.maxResults ?? 100,
      });
      if (r.error) return r.error;
      return jsonResult({
        system: sys,
        scope: `transport:${trId}`,
        objectCount: refs.length,
        truncated: refs.length === maxObjects,
        checkVariant: r.checkVariant,
        worklistId: r.worklistId,
        findingCount: r.findings.length,
        byPriority: summarizeFindings(r.findings),
        findings: r.findings,
        raw: r.findings.length === 0 ? r.resultXml.slice(0, 4000) : undefined,
      });
    },
  };
}
