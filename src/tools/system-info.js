import { errorResult, jsonResult } from "../result.js";
import { parseDataPreview } from "../data-preview.js";
import { SYSTEM_HINT } from "./_shared.js";

// Reuses the same Data Preview freestyle-SELECT endpoint as adt_read_table
// (see src/tools/data.js) — no new ADT endpoint, just two canned, safe
// SELECTs against CVERS (installed software components), a table present on
// every NetWeaver / S/4HANA system since it drives the standard system-info
// screens (SSAA / System > Status).
const FREESTYLE_PATH = "/sap/bc/adt/datapreview/freestyle";

async function runSelect(client, query) {
  const res = await client.request({
    method: "POST",
    path: FREESTYLE_PATH,
    query: { rowNumber: "20" },
    headers: { "Content-Type": "text/plain; charset=utf-8" },
    body: query,
    accept: "application/vnd.sap.adt.datapreview.table.v1+xml",
  });
  const text = await res.text();
  if (!res.ok) {
    return { ok: false, status: res.status, text, contentType: res.headers.get("content-type") };
  }
  return { ok: true, parsed: parseDataPreview(text) };
}

export const tools = [
  {
    name: "adt_system_info",
    description:
      "Identify the connected SAP system: SAP_BASIS release/extension release, and whether it's S/4HANA (S4CORE/S4COREOP installed) or a classic ECC/NetWeaver-only system. Read-only — derived from table CVERS (installed software components) via the same Data Preview mechanism as adt_read_table, so it needs the same NetWeaver 7.55+ / S/4HANA baseline. Useful before choosing a release-sensitive tool or ADT endpoint, or before deciding whether Clean Core / ABAP Cloud guidance applies.",
    inputSchema: {
      type: "object",
      properties: {
        system: { type: "string", description: SYSTEM_HINT },
      },
    },
  },
];

export function register({ getClient }) {
  return {
    adt_system_info: async (args) => {
      const { client, name: sys } = getClient(args.system);

      const basis = await runSelect(
        client,
        "SELECT component, release, extrelease FROM cvers WHERE component = 'SAP_BASIS'"
      );
      if (!basis.ok) {
        return errorResult(sys, basis.status, basis.text, basis.contentType, {
          stage: "cvers-sap-basis",
        });
      }

      const s4 = await runSelect(
        client,
        "SELECT component, release, extrelease FROM cvers WHERE component IN ('S4CORE', 'S4COREOP')"
      );
      if (!s4.ok) {
        return errorResult(sys, s4.status, s4.text, s4.contentType, { stage: "cvers-s4core" });
      }

      const basisRow = basis.parsed.rows[0];
      const s4Rows = s4.parsed.rows ?? [];

      return jsonResult({
        system: sys,
        sapBasisRelease: basisRow?.RELEASE,
        sapBasisExtRelease: basisRow?.EXTRELEASE,
        isS4HANA: s4Rows.length > 0,
        s4Components: s4Rows,
        note:
          "Derived from table CVERS. This tells you SAP_BASIS/S4CORE release, not ABAP Cloud/Steampunk availability — that needs a separate check.",
      });
    },
  };
}
