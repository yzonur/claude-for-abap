// ADT publishes only part of the repository as first-class REST resources. Its
// discovery document lists 403 collections and none of them covers Adobe forms
// (SFPF/SFPI) or transactions (TRAN) — probing /sap/bc/adt/sfp/... returns 404
// ExceptionResourceNotFound.
//
// Such objects are still reachable, through the generic workbench bridge:
//
//   /sap/bc/adt/vit/wb/object_type/<type><subtype>/object_name/<NAME>
//
// which answers 200 with application/vnd.sap.adt.basic.object.properties+xml —
// an <adtcore:mainObject> carrying responsible / master language / package /
// description / timestamps. What it does *not* have is source: the same URI
// with /source/main appended returns 404 "No suitable resource found".
//
// So for these types the honest answer is "ADT has metadata but no source
// document; the object is edited in SAP GUI" — which is a far better result
// than the bare "Unsupported object type" crash the caller used to get (#109).
//
// The URI cannot be derived from the caller's input: the path segment needs the
// TADIR *subtype* (SFPI/5I → sfpi5i, SFPF/5F → sfpf5f, TRAN/T → trant), and
// callers legitimately pass the bare type ("SFPI"). The repository search knows
// the full type, and returns exactly this URI — so ask it rather than guess.

import { parseObjectReferences } from "./object-references.js";

const WB_URI_RE = /\/vit\/wb\/object_type\/([^/]+)\/object_name\//i;

export function isWorkbenchUri(uri) {
  return WB_URI_RE.test(String(uri ?? ""));
}

// Look the object up by name and hand back what the repository says it is.
// Returns { uri, type, name, description, packageName } or undefined — never
// throws, so callers can treat it as a best-effort enrichment.
export async function findObjectByName(client, name) {
  if (!client || typeof name !== "string" || name.length === 0) return undefined;
  try {
    const res = await client.request({
      method: "GET",
      path: "/sap/bc/adt/repository/informationsystem/search",
      query: { operation: "quickSearch", query: name, maxResults: "10" },
    });
    if (!res.ok) return undefined;
    const wanted = name.toUpperCase();
    // quickSearch matches by prefix — insist on the exact name so a near-miss
    // never gets read in place of the object that was asked for.
    const hit = parseObjectReferences(await res.text()).find(
      (r) => r.name && r.name.toUpperCase() === wanted && r.uri
    );
    if (!hit) return undefined;
    return {
      uri: hit.uri,
      type: hit.type,
      name: hit.name,
      description: hit.description,
      packageName: hit.packageName,
    };
  } catch {
    return undefined;
  }
}

const PROPS_ACCEPT = "application/vnd.sap.adt.basic.object.properties+xml";

// Fetch the workbench object-properties document for `uri`. Returns
// { ok, status, text } so the caller can surface a failure verbatim.
export async function fetchWorkbenchProperties(client, uri) {
  const res = await client.request({ path: uri, accept: PROPS_ACCEPT });
  const text = await res.text();
  return { ok: res.ok, status: res.status, text, contentType: res.headers.get("content-type") };
}

// Pull the interesting attributes out of <adtcore:mainObject …/>, so the caller
// gets structured data instead of a wall of XML.
const ATTR_RE = /([\w:.-]+)\s*=\s*"([^"]*)"/g;

export function parseObjectProperties(xml) {
  if (typeof xml !== "string") return undefined;
  const m = /<(?:\w+:)?mainObject\b([^>]*)>/i.exec(xml);
  if (!m) return undefined;
  const out = {};
  for (const a of m[1].matchAll(ATTR_RE)) {
    const key = a[1].replace(/^adtcore:/, "");
    if (key.startsWith("xmlns")) continue;
    out[key] = a[2];
  }
  const pkg = /<(?:\w+:)?packageRef\b[^>]*adtcore:name="([^"]+)"/i.exec(xml);
  if (pkg) out.package = pkg[1];
  return Object.keys(out).length ? out : undefined;
}
