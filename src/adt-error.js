// Parse SAP ADT error envelopes.
//
// ADT typically returns failures as XML wrapped in <exc:exception>:
//   <exc:exception ... xmlns:exc="http://www.sap.com/abapxml/types/communication">
//     <namespace id="com.sap.adt"/>
//     <type id="ExceptionResourceFailure"/>
//     <message lang="EN">Object ZFOO does not exist</message>
//     <localizedMessage lang="EN">...</localizedMessage>
//     <properties>
//       <entry key="LONGTEXT"><![CDATA[<html>...full diagnostics...</html>]]></entry>
//       <entry key="T100KEY-ID">SLOCK</entry>
//       <entry key="T100KEY-NO">038</entry>
//       <entry key="T100KEY-V1">…blocking-transport id…</entry>
//       <entry key="T100KEY-V2">…</entry>
//       …
//     </properties>
//   </exc:exception>
//
// On CTS / SLOCK / S_LOCK errors, the properties carry the actual diagnostic
// (which TR blocks the lock, who owns it, suggested resolution). Older code
// dropped these — surface them as `properties.longText` and `properties.t100`.
//
// Some endpoints return abap-style messages instead — we fall through to a
// best-effort message extraction.

const TYPE_RE = /<type[^>]*id\s*=\s*"([^"]+)"/i;
const NS_RE = /<namespace[^>]*id\s*=\s*"([^"]+)"/i;
const MSG_RE = /<message[^>]*>([\s\S]*?)<\/message>/i;
const LOCAL_MSG_RE = /<localizedMessage[^>]*>([\s\S]*?)<\/localizedMessage>/i;

// Match both <entry key="X">val</entry> and <property name="X">val</property>
// shapes — different ADT endpoints use different conventions.
const PROPERTY_RE =
  /<(?:entry|property)\b[^>]*\b(?:key|name)\s*=\s*"([^"]+)"[^>]*>([\s\S]*?)<\/(?:entry|property)>/gi;

export function parseAdtError(body, contentType) {
  if (typeof body !== "string" || body.length === 0) return null;

  const isXml =
    (contentType && /xml/i.test(contentType)) ||
    body.trimStart().startsWith("<");

  if (!isXml) return null;

  const hasExceptionTag = /<\w*:?exception\b/i.test(body);
  if (!hasExceptionTag && !MSG_RE.test(body)) return null;

  const type = match(body, TYPE_RE);
  const namespace = match(body, NS_RE);
  const message = decode(match(body, MSG_RE));
  const localizedMessage = decode(match(body, LOCAL_MSG_RE));
  const props = extractProperties(body);

  if (!type && !message && !localizedMessage && !props) return null;

  return {
    type,
    namespace,
    message,
    localizedMessage: localizedMessage === message ? undefined : localizedMessage,
    ...(props ? { properties: props } : {}),
  };
}

function extractProperties(body) {
  const raw = {};
  let m;
  PROPERTY_RE.lastIndex = 0;
  while ((m = PROPERTY_RE.exec(body)) !== null) {
    const key = m[1];
    const value = stripCData(m[2]);
    if (key && value) raw[key] = decode(value).trim();
  }
  if (Object.keys(raw).length === 0) return null;

  const result = {};
  if (raw.LONGTEXT) {
    result.longText = stripHtml(raw.LONGTEXT);
  }
  const t100 = {};
  if (raw["T100KEY-ID"]) t100.id = raw["T100KEY-ID"];
  if (raw["T100KEY-NO"]) t100.number = raw["T100KEY-NO"];
  for (let i = 1; i <= 4; i++) {
    const v = raw[`T100KEY-V${i}`];
    if (v) {
      t100.vars = t100.vars || [];
      t100.vars.push(v);
    }
  }
  if (Object.keys(t100).length > 0) result.t100 = t100;

  // Anything else (e.g. CTS-specific properties) — keep as `other`.
  const other = {};
  for (const k of Object.keys(raw)) {
    if (k === "LONGTEXT" || k.startsWith("T100KEY-")) continue;
    other[k] = raw[k];
  }
  if (Object.keys(other).length > 0) result.other = other;

  return Object.keys(result).length > 0 ? result : null;
}

// Some ADT failures arrive as a bare 500 whose message names a *protocol*
// mistake on our side rather than a backend problem — "Missing correction
// number" is really "you did not pass a transport", "Missing lock handle" is
// really "the stateful lock is gone". Left untranslated the agent reads them as
// backend breakage and retries the same call (#106, #110). Match on the
// message, not the exception type: the same type covers unrelated failures.
const ERROR_HINTS = [
  {
    match: /missing correction number/i,
    hint:
      "The object is under change control and the write carried no transport. Pass `transport` " +
      "(a modifiable request owned by you — adt_list_transports shows them), or create one with " +
      "adt_create_transport.",
  },
  {
    match: /missing lock handle/i,
    hint:
      "No valid lock handle reached the backend. ADT locks are bound to one stateful session: " +
      "acquire the lock with adt_lock and use the returned `lockHandle` in the same session. " +
      "A handle from an earlier session (or one already released) is no longer accepted — " +
      "call adt_lock again to get a fresh one.",
  },
  {
    // Asking for a class include that does not exist answers with the name of
    // the generated include (…===CCAU for test classes, ===CCIMP for local
    // definitions) and a line about inactive versions — which describes the
    // lookup ADT tried, not the caller's problem. Say what it means.
    match: /===\w+ does not have any inactive version/i,
    hint:
      "That class include does not exist. ADT generates one include per section " +
      "(===CCAU test classes, ===CCIMP local implementations, ===CCDEF local definitions) " +
      "and only for the sections the class actually has. Read the class object URI first — " +
      "its <class:include> entries list which ones are present.",
  },
  {
    match: /is used in multiple master programs/i,
    hint:
      "The include belongs to more than one main program, so activation cannot pick a context on " +
      "its own. Activate the master program instead (pass its name to adt_activate), or pass the " +
      "include together with the owning program in the same `objects` list.",
  },
];

// Best-effort, side-effect-free: returns a caller-facing hint for a parsed ADT
// error, or undefined when nothing matches.
export function hintForAdtError(parsed) {
  if (!parsed) return undefined;
  const haystack = [parsed.message, parsed.localizedMessage, parsed.properties?.longText]
    .filter((s) => typeof s === "string" && s.length > 0)
    .join("\n");
  if (!haystack) return undefined;
  return ERROR_HINTS.find((h) => h.match.test(haystack))?.hint;
}

function stripCData(s) {
  if (!s) return s;
  const trimmed = s.trim();
  const m = trimmed.match(/^<!\[CDATA\[([\s\S]*)\]\]>$/);
  return m ? m[1] : trimmed;
}

function stripHtml(s) {
  if (!s) return s;
  return s
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/\u00A0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function match(s, re) {
  const m = s.match(re);
  return m ? m[1].trim() : undefined;
}

function decode(s) {
  if (!s) return s;
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}
