import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "../src/tools/system-info.js";

function textResponse(body, { ok = true, status = 200, contentType = "application/vnd.sap.adt.datapreview.table.v1+xml" } = {}) {
  return {
    ok,
    status,
    headers: { get: () => contentType },
    text: async () => body,
  };
}

function columnMajorXml(rows) {
  // rows: array of objects sharing the same keys — mirrors the real
  // column-major table.v1+xml shape (see src/data-preview.js parseColumnMajor).
  const columns = Object.keys(rows[0] ?? {});
  const colsXml = columns
    .map(
      (name) => `
      <dataPreview:columns>
        <dataPreview:metadata dataPreview:name="${name}" dataPreview:type="C"/>
        <dataPreview:dataSet>
          ${rows.map((r) => `<dataPreview:data>${r[name]}</dataPreview:data>`).join("\n")}
        </dataPreview:dataSet>
      </dataPreview:columns>`
    )
    .join("");
  return `<dataPreview:tableData xmlns:dataPreview="http://www.sap.com/adt/dataPreview">
    <dataPreview:totalRows>${rows.length}</dataPreview:totalRows>
    ${colsXml}
  </dataPreview:tableData>`;
}

// Fake client: dispatches on the request body (which of the two canned
// SELECTs is being asked for) rather than on call order, so test intent is
// obvious from the SQL alone.
function makeCtx(bySql) {
  const calls = [];
  const ctx = {
    getClient: () => ({
      name: "TEST",
      client: {
        request: async (call) => {
          calls.push(call);
          const body = String(call.body ?? "");
          for (const [pattern, response] of bySql) {
            if (pattern.test(body)) return response;
          }
          throw new Error(`Unexpected query in test: ${body}`);
        },
      },
    }),
  };
  return { ctx, calls };
}

test("adt_system_info reports S/4HANA when S4CORE is installed", async () => {
  const { ctx, calls } = makeCtx([
    [
      /SAP_BASIS/,
      textResponse(columnMajorXml([{ COMPONENT: "SAP_BASIS", RELEASE: "758", EXTRELEASE: "0004" }])),
    ],
    [
      /S4CORE/,
      textResponse(columnMajorXml([{ COMPONENT: "S4CORE", RELEASE: "108", EXTRELEASE: "0004" }])),
    ],
  ]);

  const { adt_system_info } = register(ctx);
  const result = await adt_system_info({});
  const payload = JSON.parse(result.content[0].text);

  assert.equal(result.isError, false);
  assert.equal(payload.system, "TEST");
  assert.equal(payload.sapBasisRelease, "758");
  assert.equal(payload.sapBasisExtRelease, "0004");
  assert.equal(payload.isS4HANA, true);
  assert.equal(payload.s4Components.length, 1);
  assert.equal(payload.s4Components[0].COMPONENT, "S4CORE");
  assert.equal(calls.length, 2, "should issue exactly two SELECTs");
});

test("adt_system_info reports classic (non-S/4) when no S4 component is installed", async () => {
  const { ctx } = makeCtx([
    [
      /SAP_BASIS/,
      textResponse(columnMajorXml([{ COMPONENT: "SAP_BASIS", RELEASE: "740", EXTRELEASE: "0018" }])),
    ],
    [
      /S4CORE/,
      textResponse(
        `<dataPreview:tableData xmlns:dataPreview="http://www.sap.com/adt/dataPreview"><dataPreview:totalRows>0</dataPreview:totalRows></dataPreview:tableData>`
      ),
    ],
  ]);

  const { adt_system_info } = register(ctx);
  const result = await adt_system_info({});
  const payload = JSON.parse(result.content[0].text);

  assert.equal(result.isError, false);
  assert.equal(payload.sapBasisRelease, "740");
  assert.equal(payload.isS4HANA, false);
  assert.deepEqual(payload.s4Components, []);
});

test("adt_system_info surfaces an ADT error via errorResult and stops after the failing SELECT", async () => {
  const { ctx, calls } = makeCtx([
    [
      /SAP_BASIS/,
      textResponse(
        `<?xml version="1.0"?><exc:exception xmlns:exc="http://www.sap.com/abapxml/types/communicationframework"><message>boom</message></exc:exception>`,
        { ok: false, status: 400, contentType: "application/xml" }
      ),
    ],
  ]);

  const { adt_system_info } = register(ctx);
  const result = await adt_system_info({});
  const payload = JSON.parse(result.content[0].text);

  assert.equal(result.isError, true);
  assert.equal(payload.status, 400);
  assert.equal(payload.ok, false);
  assert.equal(calls.length, 1, "must not issue the second SELECT once the first failed");
});
