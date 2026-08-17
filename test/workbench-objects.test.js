import { test } from "node:test";
import assert from "node:assert/strict";

import { register } from "../src/tools/source.js";
import {
  isWorkbenchUri,
  parseObjectProperties,
  findObjectByName,
} from "../src/workbench-objects.js";

// Shapes taken verbatim from a probe against a live system (#109).
const SFPI_URI =
  "/sap/bc/adt/vit/wb/object_type/sfpi5i/object_name/%2fFGLR%2fAI_RENTAL_RETURN";

const SEARCH_HIT = {
  ok: true,
  status: 200,
  headers: { get: () => "application/xml" },
  text: async () =>
    '<adtcore:objectReferences xmlns:adtcore="http://www.sap.com/adt/core">' +
    `<adtcore:objectReference adtcore:uri="${SFPI_URI}" adtcore:type="SFPI/5I"` +
    ' adtcore:name="/FGLR/AI_RENTAL_RETURN" adtcore:description="FIT Rent Return Interface"/>' +
    "</adtcore:objectReferences>",
};

const PROPERTIES = {
  ok: true,
  status: 200,
  headers: { get: () => "application/vnd.sap.adt.basic.object.properties+xml" },
  text: async () =>
    '<adtcore:mainObject xmlns:adtcore="http://www.sap.com/adt/core" adtcore:responsible="X-KILGIN"' +
    ' adtcore:masterLanguage="EN" adtcore:masterSystem="E4D" adtcore:name="/FGLR/AI_RENTAL_RETURN"' +
    ' adtcore:type="SFPI/5I" adtcore:version="active" adtcore:description="FIT Rent Return Interface">' +
    '<adtcore:packageRef adtcore:uri="/sap/bc/adt/packages/%2ffglr%2fprints" adtcore:type="DEVC/K"' +
    ' adtcore:name="/FGLR/PRINTS"/></adtcore:mainObject>',
};

const NOTHING = {
  ok: true,
  status: 200,
  headers: { get: () => "application/xml" },
  text: async () => '<adtcore:objectReferences xmlns:adtcore="http://www.sap.com/adt/core"/>',
};

function makeCtx(responses) {
  const calls = [];
  let i = 0;
  return {
    calls,
    ctx: {
      getClient: () => ({
        client: {
          request: async (call) => {
            calls.push(call);
            return responses[i++] ?? NOTHING;
          },
        },
        name: "E4T",
        profile: { user: "TESTER" },
      }),
      config: { systems: {}, defaultSystem: null },
    },
  };
}

test("isWorkbenchUri recognises the generic workbench bridge", () => {
  assert.equal(isWorkbenchUri(SFPI_URI), true);
  assert.equal(isWorkbenchUri("/sap/bc/adt/vit/wb/object_type/trant/object_name/ZPROC"), true);
  assert.equal(isWorkbenchUri("/sap/bc/adt/oo/classes/zcl_a"), false);
  assert.equal(isWorkbenchUri(undefined), false);
});

test("parseObjectProperties lifts the mainObject attributes and its package", async () => {
  const p = parseObjectProperties(await PROPERTIES.text());
  assert.equal(p.name, "/FGLR/AI_RENTAL_RETURN");
  assert.equal(p.type, "SFPI/5I");
  assert.equal(p.responsible, "X-KILGIN");
  assert.equal(p.masterSystem, "E4D");
  assert.equal(p.package, "/FGLR/PRINTS");
  assert.equal(parseObjectProperties("<nothing/>"), undefined);
});

test("findObjectByName: a prefix match is not accepted as the object", async () => {
  const { ctx } = makeCtx([SEARCH_HIT]);
  const { client } = ctx.getClient();
  assert.equal(await findObjectByName(client, "/FGLR/AI_RENTAL"), undefined);
});

test("adt_get_source: an SFPI returns workbench properties, not 'Unsupported object type' — #109", async () => {
  const { ctx } = makeCtx([SEARCH_HIT, PROPERTIES]);
  const r = await register(ctx).adt_get_source({
    object: "/FGLR/AI_RENTAL_RETURN",
    type: "SFPI",
    system: "E4T",
  });
  assert.notEqual(r.isError, true);
  const out = JSON.parse(r.content[0].text);
  assert.equal(out.available, false);
  assert.equal(out.type, "SFPI/5I");
  assert.equal(out.path, SFPI_URI);
  assert.equal(out.properties.package, "/FGLR/PRINTS");
  assert.match(out.note, /no source document/i);
  assert.match(out.note, /SAP GUI/);
  assert.equal(out.source, undefined, "there is no source to report");
});

test("adt_get_source: an unknown type the search can't place still errors — #109", async () => {
  const { ctx } = makeCtx([NOTHING]);
  const r = await register(ctx).adt_get_source({ object: "ZNOPE", type: "WAPA" });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /Unsupported object type/);
  assert.match(r.content[0].text, /adt_request/);
});
