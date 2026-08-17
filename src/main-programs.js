// An ABAP include has no identity of its own: it compiles, and activates, only
// inside a main (master) program. ADT exposes the candidates under
// {includeObjUri}/mainprograms, and callers pass the chosen one as ?context=.
//
// Shared by adt_syntax_check (which needs a context or the check comes back
// "notProcessed") and adt_activate (which 500s with "REPS X is used in multiple
// master programs" when the include belongs to more than one, #113).

const REF_RE = /<(?:\w+:)?objectReference\b[^>]*>/gi;
const BARE_URI_RE = /adtcore:uri="([^"]+)"/gi;

// Normalize a caller-supplied include context into an ADT object URI. Accepts a
// full ADT path as-is; treats anything else as a program name.
//
// A real ADT object URI begins with the ADT path prefix. A *namespaced* ABAP
// name (e.g. "/FGLR/R_PO_ASSET_CREATE") also begins with "/", so keying on a
// leading slash alone misclassified it as a ready-made URI and produced an
// unmappable ?context= → 500 uriMappingError (#67). Only the ADT-path prefix
// marks a ready URI; every other value — bare or namespaced — is a program name
// whose slashes must be percent-encoded into the programs URI.
export function toContextUri(input) {
  const s = String(input).trim();
  if (s.startsWith("/sap/bc/adt/")) return s;
  return `/sap/bc/adt/programs/programs/${encodeURIComponent(s.toLowerCase())}`;
}

export function parseMainPrograms(xml) {
  if (typeof xml !== "string") return [];
  const out = [];
  for (const m of xml.match(REF_RE) ?? []) {
    const uri = /adtcore:uri="([^"]+)"/i.exec(m)?.[1];
    if (!uri) continue;
    const name = /adtcore:name="([^"]+)"/i.exec(m)?.[1];
    out.push({ uri: uri.replace(/&amp;/g, "&"), ...(name ? { name } : {}) });
  }
  if (out.length) return out;
  // Older releases wrap the entries in an element we don't recognise; the URIs
  // are still the only adtcore:uri values in the document.
  for (const m of xml.matchAll(BARE_URI_RE)) {
    out.push({ uri: m[1].replace(/&amp;/g, "&") });
  }
  return out;
}

// Best-effort: list an include's main programs via its /mainprograms
// sub-resource. Any failure (older release, no main program, 4xx) returns an
// empty list so the caller can degrade instead of blowing up.
export async function listMainPrograms(client, includeObjUri) {
  try {
    const res = await client.request({ path: `${includeObjUri}/mainprograms` });
    if (!res.ok) return [];
    return parseMainPrograms(await res.text());
  } catch {
    return [];
  }
}

// The first main program, or undefined. Kept for callers that only need *a*
// context and treat ambiguity as acceptable (syntax check).
export async function deriveMainProgram(client, includeObjUri) {
  return (await listMainPrograms(client, includeObjUri))[0]?.uri;
}
