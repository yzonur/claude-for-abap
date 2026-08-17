import { test } from "node:test";
import assert from "node:assert/strict";

import { register, parseVersionList, VERSIONS_ACCEPT } from "../src/tools/versions.js";

function makeCtx({ responses } = {}) {
  const calls = [];
  let i = 0;
  const ctx = {
    getClient: () => ({
      client: {
        request: async (call) => {
          calls.push(call);
          return responses ? responses[i++] ?? responses[responses.length - 1] : {
            ok: true,
            status: 200,
            headers: { get: () => "text/plain" },
            text: async () => "",
          };
        },
      },
      name: "FAKE",
      profile: { user: "TESTER" },
    }),
    config: { systems: {}, defaultSystem: null },
  };
  return { ctx, calls };
}

const resp = (body, ok = true, status = 200) => ({
  ok,
  status,
  headers: { get: () => "text/plain" },
  text: async () => body,
});

test("parseVersionList: extracts version attributes", () => {
  const xml =
    '<vrs:versions><vrs:version vrs:number="000002" vrs:author="DEV" vrs:date="20260101"/>' +
    '<vrs:version vrs:number="000001" vrs:author="DEV2"/></vrs:versions>';
  const v = parseVersionList(xml);
  assert.equal(v.length, 2);
  assert.equal(v[0].number, "000002");
  assert.equal(v[0].author, "DEV");
});

test("adt_list_versions: 404 → available:false with hint, not an error", async () => {
  const { ctx } = makeCtx({ responses: [resp("No suitable resource found", false, 404)] });
  const h = register(ctx);
  const r = await h.adt_list_versions({ object: "ZCL_A", type: "class" });
  assert.notEqual(r.isError, true); // graceful, not an error
  const out = JSON.parse(r.content[0].text);
  assert.equal(out.available, false);
  assert.match(out.hint, /adt_compare_versions/);
});

test("adt_list_versions: 200 → parsed versions, available:true", async () => {
  const xml = '<vrs:versions><vrs:version vrs:number="000001" vrs:author="X"/></vrs:versions>';
  const { ctx, calls } = makeCtx({ responses: [resp(xml)] });
  const h = register(ctx);
  const r = await h.adt_list_versions({ object: "ZCL_A", type: "class" });
  const out = JSON.parse(r.content[0].text);
  assert.equal(out.available, true);
  assert.equal(out.count, 1);
  assert.match(calls[0].path, /\/sap\/bc\/adt\/oo\/classes\/zcl_a\/versions$/);
});

test("adt_compare_versions: diffs from/to with version query params", async () => {
  const { ctx, calls } = makeCtx({
    responses: [resp("line1\nline2\nline3"), resp("line1\nCHANGED\nline3")],
  });
  const h = register(ctx);
  const r = await h.adt_compare_versions({ object: "ZCL_A", type: "class" });
  const out = JSON.parse(r.content[0].text);
  assert.equal(out.from, "inactive");
  assert.equal(out.to, "active");
  assert.equal(calls[0].query.version, "inactive");
  assert.equal(calls[1].query.version, "active");
  assert.equal(out.identical, false);
  assert.ok(out.stats.added >= 1 && out.stats.removed >= 1);
});

test("adt_compare_versions: identical sources → identical:true", async () => {
  const { ctx } = makeCtx({ responses: [resp("same\ntext"), resp("same\ntext")] });
  const h = register(ctx);
  const r = await h.adt_compare_versions({ object: "ZCL_A", type: "class", from: "active", to: "active" });
  const out = JSON.parse(r.content[0].text);
  assert.equal(out.identical, true);
});

test("parseVersionList: falls back to atom entries — #111", () => {
  const xml =
    '<atom:feed xmlns:atom="http://www.w3.org/2005/Atom">' +
    '<atom:entry><atom:title>000002</atom:title>' +
    '<atom:link href="/sap/bc/adt/vit/versions/2" rel="self"/>' +
    "<adtcore:author>DEV</adtcore:author></atom:entry>" +
    '<atom:entry><atom:title>000001</atom:title>' +
    "<adtcore:author>DEV2</adtcore:author></atom:entry>" +
    "</atom:feed>";
  const v = parseVersionList(xml);
  assert.equal(v.length, 2);
  assert.equal(v[0].title, "000002");
  assert.equal(v[0].author, "DEV");
  assert.equal(v[0].href, "/sap/bc/adt/vit/versions/2");
  assert.equal(v[1].author, "DEV2");
  // xmlns declarations are noise and must not leak into the version rows.
  assert.equal(v[0].xmlns, undefined);
});

test("adt_list_versions: asks for the atom feed the endpoint serves — #111", async () => {
  const { ctx, calls } = makeCtx({ responses: [resp("<atom:feed/>")] });
  const h = register(ctx);
  await h.adt_list_versions({ object: "ZI_A", type: "cds" });
  assert.equal(calls[0].accept, VERSIONS_ACCEPT);
  assert.match(calls[0].accept, /atom\+xml/);
});

test("adt_compare_versions: numeric version is rejected before the round trip — #112", async () => {
  const { ctx, calls } = makeCtx({ responses: [resp("x"), resp("y")] });
  const h = register(ctx);
  const r = await h.adt_compare_versions({ object: "ZI_A", type: "cds", from: "1", to: "active" });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /only accepts/);
  assert.match(r.content[0].text, /`from`/);
  assert.equal(calls.length, 0);
});

test("adt_compare_versions: from-side fetch error is surfaced with side label", async () => {
  const { ctx } = makeCtx({
    responses: [resp("boom", false, 500), resp("ok")],
  });
  const h = register(ctx);
  const r = await h.adt_compare_versions({ object: "ZCL_A", type: "class" });
  assert.equal(r.isError, true);
  const out = JSON.parse(r.content[0].text);
  assert.equal(out.side, "from");
});
