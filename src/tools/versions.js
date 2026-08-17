import { objectUri, sourceUri, normalizeType } from "../object-uris.js";
import { unifiedLineDiff } from "../diff.js";
import { errorResult, jsonResult, textResult } from "../result.js";
import { OBJECT_TYPE_HINT, SYSTEM_HINT } from "./_shared.js";

// Parse <vrs:version .../> or generic version entries that some ADT releases
// expose under {objectUri}/versions. Shapes vary; we collect every attribute.
const VERSION_RE = /<(?:vrs:)?version\b([\s\S]*?)(?:\/>|>)/gi;
const ATTR_RE = /([\w:.-]+)\s*=\s*"([^"]*)"/g;

// The endpoint answers as an Atom feed (see ACCEPT below), so the version rows
// arrive as <atom:entry> elements whose payload sits partly in attributes of
// nested elements and partly in child text. Match the whole entry so both can
// be harvested (#111).
const ENTRY_RE = /<(?:\w+:)?entry\b[^>]*>([\s\S]*?)<\/(?:\w+:)?entry>/gi;
const CHILD_TEXT_RE = /<(?:\w+:)?([\w.-]+)\b[^>]*>([^<]*)<\/(?:\w+:)?[\w.-]+>/g;

function localName(qname) {
  return qname.replace(/^[\w]+:/, "");
}

export function parseVersionList(xml) {
  if (typeof xml !== "string") return [];
  const out = [];
  for (const m of xml.matchAll(VERSION_RE)) {
    const attrs = {};
    for (const a of m[1].matchAll(ATTR_RE)) {
      attrs[localName(a[1])] = a[2];
    }
    if (Object.keys(attrs).length) out.push(attrs);
  }
  if (out.length) return out;

  // Atom-feed shape: one <entry> per version. Collect every attribute found
  // anywhere inside the entry plus every child element with plain text, so the
  // caller sees the version number / user / timestamp whatever the release
  // decided to call them. Last write wins — attributes are the more specific
  // carrier, so they are read after the child text.
  for (const e of xml.matchAll(ENTRY_RE)) {
    const inner = e[1];
    const row = {};
    for (const c of inner.matchAll(CHILD_TEXT_RE)) {
      const value = c[2].trim();
      if (value) row[localName(c[1])] = value;
    }
    for (const a of inner.matchAll(ATTR_RE)) {
      const key = localName(a[1]);
      // Namespace declarations are noise, not version data.
      if (key === "xmlns" || a[1].startsWith("xmlns:")) continue;
      row[key] = a[2];
    }
    if (Object.keys(row).length) out.push(row);
  }
  return out;
}

// {objectUri}/versions is an Atom feed and nothing else: asking for
// "application/xml" makes it answer 406 ExceptionResourceNotAcceptable with
// "Accepted content types: application/atom+xml;type=feed" (#111).
export const VERSIONS_ACCEPT = "application/atom+xml;type=feed";

export const tools = [
  {
    name: "adt_list_versions",
    description:
      "List the version history of an object via the ADT versions sub-resource ({objectUri}/versions). NOTE: many on-prem NetWeaver releases do not expose a version-history REST endpoint and return 404 — in that case use adt_compare_versions to diff active vs inactive instead. The response carries available:false with a hint when the endpoint is absent.",
    inputSchema: {
      type: "object",
      properties: {
        system: { type: "string", description: SYSTEM_HINT },
        object: { type: "string", description: "Object name." },
        type: { type: "string", description: OBJECT_TYPE_HINT },
        group: { type: "string", description: "Function group (for FUGR/FF or FUGR/I)." },
      },
      required: ["object", "type"],
    },
  },
  {
    name: "adt_compare_versions",
    description:
      "Diff two versions of the SAME object's source within one system. Defaults to active-vs-inactive (the daily 'what did I change but not yet activate' question). from/to are passed to the ADT ?version= query, which only understands the symbolic values 'active' and 'inactive' — a numeric version number is rejected with 400 ExceptionParameterValueInvalid. Returns a unified diff plus added/removed line counts, reusing the same diff engine as adt_compare_source.",
    inputSchema: {
      type: "object",
      properties: {
        system: { type: "string", description: SYSTEM_HINT },
        object: { type: "string", description: "Object name." },
        type: { type: "string", description: OBJECT_TYPE_HINT },
        group: { type: "string", description: "Function group (for FUGR/FF or FUGR/I)." },
        include: { type: "string", description: "For classes: which include to compare." },
        from: {
          type: "string",
          description: "Base version passed to ?version= — 'active' or 'inactive' (default 'inactive').",
        },
        to: {
          type: "string",
          description: "Target version passed to ?version= — 'active' or 'inactive' (default 'active').",
        },
        context: {
          type: "integer",
          description: "Lines of context around each diff hunk (default 3).",
          minimum: 0,
          maximum: 20,
        },
      },
      required: ["object", "type"],
    },
  },
];

export function register({ getClient }) {
  return {
    adt_list_versions: async (args) => {
      const { client, name: sys } = getClient(args.system);
      const objUri = objectUri({ type: args.type, name: args.object, group: args.group });
      const res = await client.request({
        path: `${objUri}/versions`,
        accept: VERSIONS_ACCEPT,
      });
      const text = await res.text();
      if (res.status === 404) {
        return jsonResult({
          system: sys,
          object: args.object,
          type: normalizeType(args.type),
          available: false,
          hint:
            "This system's ADT does not expose a version-history list at {objectUri}/versions. " +
            "Use adt_compare_versions (active vs inactive) for the common diff use case.",
        });
      }
      if (!res.ok) return errorResult(sys, res.status, text, res.headers.get("content-type"));
      const versions = parseVersionList(text);
      return jsonResult({
        system: sys,
        object: args.object,
        type: normalizeType(args.type),
        available: true,
        count: versions.length,
        versions,
        raw: versions.length === 0 ? text.slice(0, 4000) : undefined,
      });
    },

    adt_compare_versions: async (args) => {
      const from = args.from ?? "inactive";
      const to = args.to ?? "active";
      // ?version= takes symbolic values only. A numeric identifier read off a
      // version history 400s server-side with an opaque "could not be
      // converted" message (#112); say so here instead of paying a round trip.
      const numeric = [
        ["from", from],
        ["to", to],
      ].find(([, v]) => /^\d+$/.test(String(v).trim()));
      if (numeric) {
        return textResult(
          `adt_compare_versions: \`${numeric[0]}\` = '${numeric[1]}' — the ADT ?version= query only accepts ` +
            "'active' or 'inactive'. A numeric version number is rejected by the backend with " +
            "400 ExceptionParameterValueInvalid. To inspect older revisions use adt_list_versions " +
            "and follow the version's own URI.",
          true
        );
      }
      const { client, name: sys } = getClient(args.system);
      const path = sourceUri({
        type: args.type,
        name: args.object,
        group: args.group,
        include: args.include,
      });

      const [resFrom, resTo] = await Promise.all([
        client.request({ path, query: { version: from }, accept: "text/plain" }),
        client.request({ path, query: { version: to }, accept: "text/plain" }),
      ]);
      const [textFrom, textTo] = await Promise.all([resFrom.text(), resTo.text()]);

      if (!resFrom.ok) {
        return errorResult(sys, resFrom.status, textFrom, resFrom.headers.get("content-type"), {
          side: "from",
          version: from,
        });
      }
      if (!resTo.ok) {
        return errorResult(sys, resTo.status, textTo, resTo.headers.get("content-type"), {
          side: "to",
          version: to,
        });
      }

      const diff = unifiedLineDiff(textFrom, textTo, {
        context: args.context ?? 3,
        fromFile: `${args.object}@${from}`,
        toFile: `${args.object}@${to}`,
      });
      return jsonResult({
        system: sys,
        object: args.object,
        type: normalizeType(args.type),
        from,
        to,
        path,
        identical: diff.identical,
        stats: diff.stats,
        diff: diff.diff,
      });
    },
  };
}
