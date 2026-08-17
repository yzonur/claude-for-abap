import { test } from "node:test";
import assert from "node:assert/strict";

import { register } from "../src/tools/lifecycle.js";

function makeCtx({ responses } = {}) {
  const calls = [];
  let i = 0;
  const ctx = {
    getClient: () => ({
      client: {
        request: async (call) => {
          calls.push(call);
          if (responses && i < responses.length) return responses[i++];
          return {
            ok: true,
            status: 200,
            headers: { get: () => "application/xml" },
            text: async () => "<ok/>",
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

test("adt_activate defaults: method=activate, preauditRequested=true, no extra flags", async () => {
  const { ctx, calls } = makeCtx();
  const handlers = register(ctx);
  await handlers.adt_activate({
    objects: [{ name: "ZCL_FOO", type: "CLAS" }],
  });
  const call = calls[0];
  assert.equal(call.path, "/sap/bc/adt/activation");
  assert.deepEqual(call.query, {
    method: "activate",
    preauditRequested: "true",
  });
});

test("adt_activate forwards processRedoneOOSourceVersionOnly as isProcessRedoneOOSourceVerOnly", async () => {
  const { ctx, calls } = makeCtx();
  const handlers = register(ctx);
  await handlers.adt_activate({
    objects: [{ name: "ZCL_FOO", type: "CLAS" }],
    processRedoneOOSourceVersionOnly: true,
  });
  assert.equal(calls[0].query.isProcessRedoneOOSourceVerOnly, "true");
});

test("adt_activate allows preauditRequested override to false", async () => {
  const { ctx, calls } = makeCtx();
  const handlers = register(ctx);
  await handlers.adt_activate({
    objects: [{ name: "ZCL_FOO", type: "CLAS" }],
    preauditRequested: false,
  });
  assert.equal(calls[0].query.preauditRequested, "false");
});

// ─── #113: includes activate inside a master program ──────────────────────────

const mainProgramsFeed = (...names) => ({
  ok: true,
  status: 200,
  headers: { get: () => "application/xml" },
  text: async () =>
    '<adtcore:objectReferences xmlns:adtcore="http://www.sap.com/adt/core">' +
    names
      .map(
        (n) =>
          `<adtcore:objectReference adtcore:uri="/sap/bc/adt/programs/programs/${n.toLowerCase()}" adtcore:name="${n}"/>`
      )
      .join("") +
    "</adtcore:objectReferences>",
});

test("adt_activate: a single master program is resolved into ?context= — #113", async () => {
  const { ctx, calls } = makeCtx({ responses: [mainProgramsFeed("ZHURECINBOUND")] });
  const handlers = register(ctx);
  await handlers.adt_activate({ objects: [{ name: "ZHURECINBOUND_TOP", type: "include" }] });

  assert.match(calls[0].path, /\/programs\/includes\/zhurecinbound_top\/mainprograms$/);
  const activation = calls[1];
  assert.equal(activation.path, "/sap/bc/adt/activation");
  assert.match(
    activation.body,
    /programs\/includes\/zhurecinbound_top\?context=%2Fsap%2Fbc%2Fadt%2Fprograms%2Fprograms%2Fzhurecinbound/
  );
});

test("adt_activate: an ambiguous include asks which master program — #113", async () => {
  const { ctx, calls } = makeCtx({ responses: [mainProgramsFeed("ZMAIN_A", "ZMAIN_B")] });
  const handlers = register(ctx);
  const r = await handlers.adt_activate({
    objects: [{ name: "ZHURECINBOUND_TOP", type: "include" }],
  });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /2 master programs/);
  assert.match(r.content[0].text, /ZMAIN_A, ZMAIN_B/);
  assert.equal(calls.length, 1, "must not attempt the activation it knows will 500");
});

test("adt_activate: an explicit context skips resolution — #113", async () => {
  const { ctx, calls } = makeCtx();
  const handlers = register(ctx);
  await handlers.adt_activate({
    objects: [{ name: "ZHURECINBOUND_TOP", type: "include", context: "ZMAIN_B" }],
  });
  assert.equal(calls.length, 1, "no /mainprograms lookup when the caller already said which");
  assert.match(calls[0].body, /context=%2Fsap%2Fbc%2Fadt%2Fprograms%2Fprograms%2Fzmain_b/);
});

test("adt_activate: a non-include is untouched by context resolution — #113", async () => {
  const { ctx, calls } = makeCtx();
  const handlers = register(ctx);
  await handlers.adt_activate({ objects: [{ name: "ZCL_FOO", type: "CLAS" }] });
  assert.equal(calls.length, 1);
  assert.doesNotMatch(calls[0].body, /context=/);
});

test("adt_activate omits isProcessRedoneOOSourceVerOnly when flag is false", async () => {
  const { ctx, calls } = makeCtx();
  const handlers = register(ctx);
  await handlers.adt_activate({
    objects: [{ name: "ZCL_FOO", type: "CLAS" }],
    processRedoneOOSourceVersionOnly: false,
  });
  assert.equal(calls[0].query.isProcessRedoneOOSourceVerOnly, undefined);
});
