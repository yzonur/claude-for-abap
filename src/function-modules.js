// A function module has no ADT URI of its own — it is addressed as a child of
// its function group (/functions/groups/<grp>/fmodules/<fm>), so objectUri()
// refuses to build one without `group`. Callers routinely know only the module
// name (that is what SE37, dumps and where-used lists show), and got a hard
// error telling them to supply something they would have to go look up (#104).
//
// The RIS quick search already answers the question: searching for the module
// name returns an objectReference whose URI *contains* the owning group.

import { baseType } from "./object-uris.js";
import { parseObjectReferences } from "./object-references.js";

// Only the group segment is captured; what follows /fmodules/ is the module
// name, which the caller already has and which is not always percent-encoded.
const FMODULE_URI_RE = /\/functions\/groups\/([^/]+)\/fmodules\//i;

// Pull the group out of an ADT function-module URI. Exported for testing and
// because callers occasionally hold a URI rather than a name.
export function groupFromFunctionUri(uri) {
  const m = FMODULE_URI_RE.exec(String(uri ?? ""));
  return m ? decodeURIComponent(m[1]) : undefined;
}

// Best-effort lookup of the function group owning `name`. Returns undefined on
// any failure so the caller can fall back to its original error.
export async function resolveFunctionGroup(client, name) {
  if (typeof name !== "string" || name.length === 0) return undefined;
  try {
    const res = await client.request({
      method: "GET",
      path: "/sap/bc/adt/repository/informationsystem/search",
      query: { operation: "quickSearch", query: name, maxResults: "10", objectType: "FUGR/FF" },
    });
    if (!res.ok) return undefined;
    const wanted = name.toUpperCase();
    for (const ref of parseObjectReferences(await res.text())) {
      // quickSearch matches by prefix, so insist on the exact module before
      // borrowing its group — a near-miss would silently read another object.
      if (ref.name && ref.name.toUpperCase() !== wanted) continue;
      const group = groupFromFunctionUri(ref.uri);
      if (group) return group;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

// The group a caller should use for {type, name}: their own when they supplied
// one, a looked-up one for a bare function module, and undefined for every
// other object type (which does not take a group at all). Throwing is left to
// the URI builders — this only fills in what it can.
//
// Returns { group, resolvedGroup } so callers can tell the agent that the group
// was inferred rather than given.
export async function resolveGroup(client, { type, name, group }) {
  if (group || !client) return { group };
  let t;
  try {
    t = baseType(type);
  } catch {
    return { group };
  }
  if (t !== "FUGR/FF") return { group };
  const found = await resolveFunctionGroup(client, name);
  return found ? { group: found, resolvedGroup: true } : { group };
}
