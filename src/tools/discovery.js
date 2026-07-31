import { objectUri, sourceUri } from "../object-uris.js";
import { fetchPackageNodes } from "../node-structure.js";
import { parseObjectReferences, parseUsageReferences } from "../object-references.js";
import { errorResult, jsonResult, textResult } from "../result.js";
import { OBJECT_TYPE_HINT, SYSTEM_HINT } from "./_shared.js";

// Default cap on the where-used list. RIS happily returns five figures of
// references for a central object; the caller can raise it per call.
const WHERE_USED_DEFAULT_MAX = 200;

function defaultDescendPrefix(pkg) {
  if (pkg.startsWith("/")) {
    const second = pkg.indexOf("/", 1);
    if (second > 0) return pkg.slice(0, second + 1);
  }
  return pkg[0] ?? "";
}

// Object base-types that expose a fetchable /source/main document. Node types
// arrive as "CLAS/OC", "PROG/P", "DDLS/DF", … — we key on the part before "/".
// DDIC primitives (TABL, DTEL, DOMA) and function groups (per-FM includes) are
// intentionally excluded: no single source document to grep.
const GREP_SOURCE_TYPES = new Set([
  "PROG",
  "CLAS",
  "INTF",
  "INCL",
  "DDLS",
  "DCLS",
  "DDLX",
  "BDEF",
]);

function baseType(adtType) {
  return (adtType || "").split("/")[0].toUpperCase();
}

// Resolve a /source/main path for a repository node, or null if the type has no
// grep-able source document.
function grepSourcePath(node) {
  const base = baseType(node.type);
  if (!GREP_SOURCE_TYPES.has(base)) return null;
  try {
    return sourceUri({ type: base, name: node.name });
  } catch {
    return null;
  }
}

// Walk a package (optionally recursively) collecting source-bearing objects up
// to maxObjects. Returns { targets:[{name,type,path}], skipped:[{name,type}],
// packagesVisited, truncated }.
async function collectPackageTargets(client, root, opts) {
  const { recursive, prefix, maxPackages, maxObjects } = opts;
  const visited = new Set();
  const targets = [];
  const skipped = [];
  let truncated = false;

  async function walk(pkg) {
    if (truncated || visited.size >= maxPackages || visited.has(pkg)) return;
    visited.add(pkg);
    const r = await fetchPackageNodes(client, pkg);
    if (!r.ok) return;
    for (const n of r.nodes) {
      if (n.type === "DEVC/K") continue; // subpackage node — handled below
      if (targets.length >= maxObjects) {
        truncated = true;
        return;
      }
      const path = grepSourcePath(n);
      if (path) targets.push({ name: n.name, type: n.type, path });
      else skipped.push({ name: n.name, type: n.type });
    }
    if (recursive) {
      for (const n of r.nodes) {
        if (n.type === "DEVC/K" && n.name.startsWith(prefix)) await walk(n.name);
      }
    }
  }

  await walk(root);
  return { targets, skipped, packagesVisited: visited.size, truncated };
}

export const tools = [
  {
    name: "adt_search_objects",
    description:
      "Quick-search the ABAP repository for objects whose name matches a pattern. Use '*' as wildcard.",
    inputSchema: {
      type: "object",
      properties: {
        system: { type: "string", description: SYSTEM_HINT },
        query: {
          type: "string",
          description: "Search pattern, e.g. 'ZCL_CUSTOMER*' or 'Z*INVOICE*'.",
        },
        maxResults: {
          type: "integer",
          description: "Maximum number of results (default 50).",
          minimum: 1,
          maximum: 500,
        },
        objectType: {
          type: "string",
          description:
            "Optional ADT object-type filter, e.g. 'CLAS/OC' for classes, 'PROG/P' for programs. Omit for all types.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "adt_where_used",
    description:
      "Where-used list for an object. Returns the references that point to it. Widely-used objects can have thousands of references, so the list is capped at `maxResults` (default 200) — `numberOfResults` always reports the backend's full count and `truncated` says whether the list was cut.",
    inputSchema: {
      type: "object",
      properties: {
        system: { type: "string", description: SYSTEM_HINT },
        object: { type: "string", description: "Object name." },
        type: { type: "string", description: OBJECT_TYPE_HINT },
        group: { type: "string", description: "Function group (for FUGR/FF or FUGR/I)." },
        maxResults: {
          type: "integer",
          description: `Maximum references to return (default ${WHERE_USED_DEFAULT_MAX}). Raise it when you need the full list of a heavily-used object.`,
          minimum: 1,
        },
      },
      required: ["object", "type"],
    },
  },
  {
    name: "adt_browse_package",
    description:
      "List the immediate contents (one level) of an ABAP package. Use adt_list_packages for recursive walks.",
    inputSchema: {
      type: "object",
      properties: {
        system: { type: "string", description: SYSTEM_HINT },
        package: {
          type: "string",
          description: "Package name (case-insensitive), e.g. 'ZLOCAL' or '/MYNS/MAIN'.",
        },
      },
      required: ["package"],
    },
  },
  {
    name: "adt_list_packages",
    description:
      "Recursively walk subpackages from a root package. Returns a flattened map of package → contents (counts and entries grouped by type).",
    inputSchema: {
      type: "object",
      properties: {
        system: { type: "string", description: SYSTEM_HINT },
        root: { type: "string", description: "Root package name to walk from." },
        prefix: {
          type: "string",
          description:
            "Only descend into subpackages whose name starts with this prefix. Defaults to namespace prefix or first character.",
        },
        maxPackages: {
          type: "integer",
          description: "Safety limit on total packages visited (default 200).",
          minimum: 1,
          maximum: 5000,
        },
      },
      required: ["root"],
    },
  },
  {
    name: "adt_grep_source",
    description:
      "Full-text regex search across ABAP source. Complements adt_search_objects (which only matches names). Scope the search to a package (optionally recursive), a transport request, or an explicit object list. Fetches /source/main for each source-bearing object (programs, classes, interfaces, includes, CDS/DDLS, DCLS, DDLX, behavior definitions) and returns matching lines as object + line + text. DDIC primitives (tables, data elements, domains) and function groups are skipped (no single source document). Bounded by maxObjects and maxMatches — large packages are truncated, not silently capped.",
    inputSchema: {
      type: "object",
      properties: {
        system: { type: "string", description: SYSTEM_HINT },
        pattern: {
          type: "string",
          description:
            "JavaScript regular expression to match against each source line, e.g. 'SELECT \\\\* FROM' or 'CALL FUNCTION'. Anchors and groups allowed.",
        },
        flags: {
          type: "string",
          description:
            "RegExp flags. Default 'i' (case-insensitive). 'g' is ignored (matching is per-line). Use '' for case-sensitive.",
        },
        package: {
          type: "string",
          description: "Scope: search every source object in this package. Mutually exclusive with transport / objects.",
        },
        recursive: {
          type: "boolean",
          description: "When package is set, also descend into subpackages (prefix-filtered). Default false.",
        },
        prefix: {
          type: "string",
          description: "Only descend into subpackages whose name starts with this prefix (recursive only). Defaults to namespace prefix / first char.",
        },
        maxPackages: {
          type: "integer",
          description: "Safety limit on packages visited when recursive (default 200).",
          minimum: 1,
          maximum: 5000,
        },
        transport: {
          type: "string",
          description: "Scope: search every object referenced by this transport request.",
        },
        objects: {
          type: "array",
          description: "Scope: explicit object list. Each item { name, type }.",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              type: { type: "string", description: OBJECT_TYPE_HINT },
            },
            required: ["name", "type"],
          },
        },
        maxObjects: {
          type: "integer",
          description: "Maximum source objects to fetch (default 100).",
          minimum: 1,
          maximum: 2000,
        },
        maxMatches: {
          type: "integer",
          description: "Maximum matching lines to return across all objects (default 200).",
          minimum: 1,
          maximum: 5000,
        },
      },
      required: ["pattern"],
    },
  },
];

export function register({ getClient }) {
  return {
    adt_search_objects: async (args) => {
      const { client, name: sys } = getClient(args.system);
      const maxResults = args.maxResults ?? 50;
      const baseQuery = {
        query: args.query,
        maxResults: String(maxResults),
      };
      if (args.objectType) baseQuery.objectType = args.objectType;

      // GET, not POST: POSTing to this path routes to the RIS object-search
      // handler, which demands a `ris_request_type` query parameter we don't
      // supply and rejects the call with 400 "Parameter ris_request_type could
      // not be found". The quickSearch operation is a GET contract (the one ADT
      // Eclipse uses) and needs no such parameter.
      const tryRequest = (extra) =>
        client.request({
          method: "GET",
          path: "/sap/bc/adt/repository/informationsystem/search",
          query: { ...baseQuery, ...extra },
        });

      let res = await tryRequest({ operation: "quickSearch" });
      let text = await res.text();
      // Older NetWeaver releases don't deploy the quickSearch operation and
      // return a 500 "No service found for ID quickSearch". Fall back to the
      // operation-less legacy search endpoint shape.
      let usedFallback = false;
      if (!res.ok && /No service found for ID\s+quickSearch/i.test(text)) {
        usedFallback = true;
        res = await tryRequest({});
        text = await res.text();
      }
      if (!res.ok) return errorResult(sys, res.status, text, res.headers.get("content-type"));
      const refs = parseObjectReferences(text);
      return jsonResult({
        system: sys,
        query: args.query,
        count: refs.length,
        hasMore: refs.length >= maxResults,
        results: refs,
        ...(usedFallback ? { operation: "legacy" } : {}),
      });
    },

    adt_where_used: async (args) => {
      const { client, name: sys } = getClient(args.system);
      let uri;
      try {
        uri = objectUri({ type: args.type, name: args.object, group: args.group });
      } catch (err) {
        // e.g. a function module (FUGR/FF) passed without its group — objectUri
        // throws. Return a clean tool error instead of crashing (#74).
        return textResult(`adt_where_used: ${err.message}`, true);
      }
      // The endpoint requires a real request body with a <usageReferenceRequest>
      // root; the previous empty POST 400'd with "System expected the element
      // usageReferenceRequest" on every object (#73). An empty <affectedObjects/>
      // means "all usages of <uri>". Mirrors the reference client (abap-adt-api).
      const body =
        `<?xml version="1.0" encoding="UTF-8"?>` +
        `<usagereferences:usageReferenceRequest xmlns:usagereferences="http://www.sap.com/adt/ris/usageReferences">` +
        `<usagereferences:affectedObjects/>` +
        `</usagereferences:usageReferenceRequest>`;
      const res = await client.request({
        method: "POST",
        path: "/sap/bc/adt/repository/informationsystem/usageReferences",
        query: { uri },
        headers: { "Content-Type": "application/*" },
        accept: "application/*",
        body,
      });
      const text = await res.text();
      if (!res.ok) return errorResult(sys, res.status, text, res.headers.get("content-type"));
      const refs = parseUsageReferences(text);
      // The backend's own count, from <usageReferenceResult numberOfResults="…">.
      // It differs from refs.length: the parser walks every <adtObject> node,
      // and a single referenced object contributes one per usage occurrence.
      const declared = /<(?:[\w]+:)?usageReferenceResult\b[^>]*\bnumberOfResults="(\d+)"/i.exec(text);
      const max =
        Number.isInteger(args.maxResults) && args.maxResults > 0
          ? args.maxResults
          : WHERE_USED_DEFAULT_MAX;
      // A heavily-used object (e.g. CL_GUI_FRONTEND_SERVICES → 11k refs, ~126 KB)
      // would otherwise flood the agent's context in one call.
      const shown = refs.slice(0, max);
      return jsonResult({
        system: sys,
        object: args.object,
        count: shown.length,
        ...(declared ? { numberOfResults: Number(declared[1]) } : {}),
        ...(refs.length > shown.length
          ? { truncated: true, totalParsed: refs.length, maxResults: max }
          : {}),
        references: shown,
        raw: refs.length === 0 ? text : undefined,
      });
    },

    adt_browse_package: async (args) => {
      // Guard the required `package` instead of crashing on `.toUpperCase()` of
      // undefined (#84). Name the wrong field when a common alias was passed.
      if (typeof args.package !== "string" || args.package.length === 0) {
        const wrong = args.packageName !== undefined ? "packageName" : args.name !== undefined ? "name" : null;
        const hint = wrong ? ` (you passed \`${wrong}\` — the field is \`package\`)` : "";
        return textResult(
          `adt_browse_package: \`package\` is required${hint} (e.g. 'ZLOCAL' or '/MYNS/MAIN').`,
          true
        );
      }
      const { client, name: sys } = getClient(args.system);
      const pkg = args.package.toUpperCase();
      const r = await fetchPackageNodes(client, pkg);
      if (!r.ok) return errorResult(sys, r.status, r.body);
      return jsonResult({ system: sys, package: pkg, total: r.nodes.length, entries: r.nodes });
    },

    adt_list_packages: async (args) => {
      // `package` is the field name on the sibling adt_browse_package tool, so
      // callers reach for it here too — accept it (and a bare `name`) as an
      // alias for `root`.
      const rootArg = args.root ?? args.package ?? args.name;
      if (typeof rootArg !== "string" || rootArg.length === 0) {
        return textResult(
          "adt_list_packages: `root` is required (the root package to walk from, e.g. 'ZFLEET').",
          true
        );
      }
      const { client, name: sys } = getClient(args.system);
      const root = rootArg.toUpperCase();
      const max = args.maxPackages ?? 200;
      const prefix = args.prefix ?? defaultDescendPrefix(root);

      const visited = new Set();
      const packages = {};

      async function walk(pkg) {
        if (visited.size >= max) return;
        if (visited.has(pkg)) return;
        visited.add(pkg);
        const r = await fetchPackageNodes(client, pkg);
        if (!r.ok) {
          packages[pkg] = { error: { status: r.status } };
          return;
        }
        const byType = {};
        for (const n of r.nodes) {
          (byType[n.type] = byType[n.type] || []).push({
            name: n.name,
            description: n.description,
          });
        }
        packages[pkg] = {
          counts: Object.fromEntries(
            Object.entries(byType).map(([k, v]) => [k, v.length])
          ),
          entries: byType,
        };
        for (const n of r.nodes) {
          if (n.type === "DEVC/K" && n.name.startsWith(prefix)) {
            await walk(n.name);
          }
        }
      }

      await walk(root);

      return jsonResult({
        system: sys,
        root,
        prefix,
        packagesVisited: visited.size,
        truncated: visited.size >= max,
        packages,
      });
    },

    adt_grep_source: async (args) => {
      const { client, name: sys } = getClient(args.system);

      const flags = (args.flags ?? "i").replace(/[gy]/g, "");
      let re;
      try {
        re = new RegExp(args.pattern, flags);
      } catch (e) {
        return textResult(
          `adt_grep_source: invalid regex /${args.pattern}/${flags}: ${e.message}`,
          true,
        );
      }

      const hasObjects = Array.isArray(args.objects) && args.objects.length > 0;
      const scopeCount = [args.package, args.transport, hasObjects].filter(Boolean).length;
      if (scopeCount !== 1) {
        return textResult(
          "adt_grep_source: provide exactly one scope — package, transport, or objects.",
          true,
        );
      }

      const maxObjects = args.maxObjects ?? 100;
      const maxMatches = args.maxMatches ?? 200;

      let targets = [];
      let skipped = [];
      let scope;
      let packagesVisited;
      let scopeTruncated = false;

      if (args.package) {
        const root = args.package.toUpperCase();
        scope = `package:${root}`;
        const prefix = args.prefix ?? defaultDescendPrefix(root);
        const r = await collectPackageTargets(client, root, {
          recursive: !!args.recursive,
          prefix,
          maxPackages: args.maxPackages ?? 200,
          maxObjects,
        });
        targets = r.targets;
        skipped = r.skipped;
        packagesVisited = r.packagesVisited;
        scopeTruncated = r.truncated;
      } else if (args.transport) {
        const trId = args.transport.toUpperCase();
        scope = `transport:${trId}`;
        const trRes = await client.request({
          path: `/sap/bc/adt/cts/transportrequests/${encodeURIComponent(trId)}`,
        });
        const trBody = await trRes.text();
        if (!trRes.ok) {
          return errorResult(sys, trRes.status, trBody, trRes.headers.get("content-type"), {
            stage: "fetch-transport",
          });
        }
        for (const ref of parseObjectReferences(trBody)) {
          if (!ref.uri) continue;
          if (targets.length >= maxObjects) {
            scopeTruncated = true;
            break;
          }
          if (GREP_SOURCE_TYPES.has(baseType(ref.type))) {
            const uri = ref.uri.split("?")[0];
            const path = uri.endsWith("/source/main") ? uri : `${uri}/source/main`;
            targets.push({ name: ref.name, type: ref.type, path });
          } else {
            skipped.push({ name: ref.name, type: ref.type });
          }
        }
      } else {
        scope = `objects:${args.objects.length}`;
        for (const o of args.objects) {
          if (targets.length >= maxObjects) {
            scopeTruncated = true;
            break;
          }
          try {
            targets.push({
              name: o.name,
              type: o.type,
              path: sourceUri({ type: o.type, name: o.name, group: o.group }),
            });
          } catch (e) {
            skipped.push({ name: o.name, type: o.type, reason: e.message });
          }
        }
      }

      const matches = [];
      const scanned = [];
      let matchTruncated = false;
      for (const t of targets) {
        if (matches.length >= maxMatches) {
          matchTruncated = true;
          break;
        }
        let res;
        let body;
        try {
          res = await client.request({ path: t.path, accept: "text/plain" });
          body = await res.text();
        } catch (e) {
          scanned.push({ name: t.name, type: t.type, error: e.message });
          continue;
        }
        if (!res.ok) {
          scanned.push({ name: t.name, type: t.type, error: `HTTP ${res.status}` });
          continue;
        }
        const lines = body.split(/\r?\n/);
        let hits = 0;
        for (let i = 0; i < lines.length; i++) {
          re.lastIndex = 0;
          if (re.test(lines[i])) {
            matches.push({
              object: t.name,
              type: t.type,
              line: i + 1,
              text: lines[i].slice(0, 300),
            });
            hits++;
            if (matches.length >= maxMatches) {
              matchTruncated = true;
              break;
            }
          }
        }
        scanned.push({ name: t.name, type: t.type, hits });
      }

      return jsonResult({
        system: sys,
        pattern: args.pattern,
        flags,
        scope,
        packagesVisited,
        objectsScanned: scanned.length,
        objectsSkipped: skipped.length,
        matchCount: matches.length,
        truncated: scopeTruncated || matchTruncated,
        truncationReason: scopeTruncated
          ? "maxObjects"
          : matchTruncated
            ? "maxMatches"
            : undefined,
        matches,
        errors: scanned.filter((s) => s.error).slice(0, 50),
        skipped: skipped.slice(0, 50),
      });
    },
  };
}
