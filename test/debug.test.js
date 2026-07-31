import { test } from "node:test";
import assert from "node:assert/strict";

import { register, _internals } from "../src/tools/debug.js";

// A router mock: each entry matches on a predicate and returns { ok, status, text }.
function makeCtx(routes, { profile } = {}) {
  const calls = [];
  const ctx = {
    getClient: () => ({
      client: {
        request: async (call) => {
          calls.push(call);
          const route = routes.find((r) => r.match(call));
          if (route?.throw) throw route.throw;
          const r = route?.reply ?? { ok: true, status: 200, text: "<x/>" };
          return {
            ok: r.ok !== false,
            status: r.status ?? 200,
            headers: { get: () => r.contentType ?? "application/xml" },
            text: async () => r.text ?? "<x/>",
          };
        },
      },
      name: "FAKE",
      profile: profile ?? { user: "DEV" },
    }),
    config: { systems: {}, defaultSystem: null },
  };
  return { ctx, calls };
}

const BP_XML =
  '<dbg:breakpoints xmlns:dbg="http://www.sap.com/adt/debugger">' +
  '<dbg:breakpoint id="BP-1" clientId="c1" kind="line" adtcore:uri="/sap/bc/adt/programs/programs/zfoo/source/main#start=5"/>' +
  "</dbg:breakpoints>";

const DEBUGGEE_XML =
  '<asx:abap xmlns:asx="http://www.sap.com/abapxml"><asx:values><DATA>' +
  "<STPDA_DEBUGGEE><CLIENT>100</CLIENT><DEBUGGEE_ID>DBG-9</DEBUGGEE_ID>" +
  "<TERMINAL_ID>t</TERMINAL_ID><IDE_ID>i</IDE_ID><DEBUGGEE_USER>DEV</DEBUGGEE_USER>" +
  "<URI>/sap/bc/adt/programs/programs/zfoo/source/main#start=5</URI></STPDA_DEBUGGEE>" +
  "</DATA></asx:values></asx:abap>";

const ATTACH_XML =
  '<dbg:attach xmlns:dbg="http://www.sap.com/adt/debugger"><reachedBreakpoints>' +
  '<breakpoint id="BP-1"/></reachedBreakpoints></dbg:attach>';

test("adt_debug_set_breakpoint builds the breakpoints POST and tracks the id", async () => {
  _internals.SESSION.breakpoints = [];
  const { ctx, calls } = makeCtx([
    { match: (c) => c.path.endsWith("/debugger/breakpoints"), reply: { text: BP_XML } },
  ]);
  const h = register(ctx);
  const r = await h.adt_debug_set_breakpoint({ object: "ZFOO", type: "program", line: 5 });
  const payload = JSON.parse(r.content[0].text);

  assert.equal(calls[0].method, "POST");
  assert.match(calls[0].path, /\/sap\/bc\/adt\/debugger\/breakpoints$/);
  assert.match(calls[0].body, /dbg:breakpoints/);
  assert.match(calls[0].body, /adtcore:uri="\/sap\/bc\/adt\/programs\/programs\/zfoo\/source\/main#start=5"/);
  assert.equal(payload.breakpoints[0].id, "BP-1");
  assert.deepEqual(_internals.SESSION.breakpoints, [{ id: "BP-1", uri: "/sap/bc/adt/programs/programs/zfoo/source/main#start=5" }]);
});

test("adt_debug_set_breakpoint escapes a condition and needs a line for object/type", async () => {
  const { ctx, calls } = makeCtx([{ match: () => true, reply: { text: BP_XML } }]);
  const h = register(ctx);
  const noLine = await h.adt_debug_set_breakpoint({ object: "ZFOO", type: "program" });
  assert.match(noLine.content[0].text, /`line`.*required/);
  assert.equal(calls.length, 0);

  await h.adt_debug_set_breakpoint({ object: "ZFOO", type: "program", line: 3, condition: 'x > "5"' });
  assert.match(calls[0].body, /condition="x &gt; &quot;5&quot;"/);
});

test("adt_debug_listen: caught → auto-attaches and returns the debuggee", async () => {
  const { ctx, calls } = makeCtx([
    { match: (c) => c.path.endsWith("/listeners"), reply: { text: DEBUGGEE_XML } },
    { match: (c) => c.query?.method === "attach", reply: { text: ATTACH_XML } },
  ]);
  const h = register(ctx);
  const r = await h.adt_debug_listen({ timeout: 1000 });
  const payload = JSON.parse(r.content[0].text);

  assert.equal(payload.caught, true);
  assert.equal(payload.attached, true);
  assert.equal(payload.debuggee.DEBUGGEE_ID, "DBG-9");
  assert.equal(payload.debuggee.DEBUGGEE_USER, "DEV");
  // The listener serves exactly one media type; anything else 406s (#95/#101).
  assert.equal(calls[0].accept, "application/vnd.sap.as+xml");
  assert.equal(calls[0].headers?.["X-sap-adt-sessiontype"], undefined, "listen is stateless");
  // second call is the attach, keyed by the debuggee id
  assert.equal(calls[1].query.method, "attach");
  assert.equal(calls[1].query.debuggeeId, "DBG-9");
});

test("every call from attach onwards is stateful, breakpoints/listen are not (#101)", async () => {
  const stateful = (c) => c.headers?.["X-sap-adt-sessiontype"];
  const { ctx, calls } = makeCtx([
    { match: (c) => c.path.endsWith("/listeners"), reply: { text: DEBUGGEE_XML } },
    { match: (c) => c.query?.method === "attach", reply: { text: ATTACH_XML } },
    { match: () => true, reply: { text: "<x/>" } },
  ]);
  const h = register(ctx);

  await h.adt_debug_set_breakpoint({ object: "ZFOO", type: "program", line: 5 });
  assert.equal(stateful(calls.at(-1)), undefined, "set_breakpoint is stateless");

  await h.adt_debug_listen({ timeout: 1000 });
  assert.equal(stateful(calls.at(-1)), "stateful", "attach opens the debug session");

  await h.adt_debug_stack({});
  assert.equal(stateful(calls.at(-1)), "stateful");
  await h.adt_debug_variables({ names: ["sy-subrc"] });
  assert.equal(stateful(calls.at(-1)), "stateful");
  await h.adt_debug_step({ kind: "over" });
  assert.equal(stateful(calls.at(-1)), "stateful");
  await h.adt_debug_goto_stack({ position: 1 });
  assert.equal(stateful(calls.at(-1)), "stateful");
  await h.adt_debug_set_variable({ name: "x", value: "1" });
  assert.equal(stateful(calls.at(-1)), "stateful");
});

test("adt_debug_listen: a 406 from the listener is an error, not caught:false (#101)", async () => {
  const { ctx } = makeCtx([
    {
      match: (c) => c.path.endsWith("/listeners"),
      reply: {
        ok: false,
        status: 406,
        text: '<exc:exception><type id="ExceptionResourceNotAcceptable"/><message lang="EN">Accepted content types: application/vnd.sap.as+xml</message></exc:exception>',
      },
    },
  ]);
  const r = await register(ctx).adt_debug_listen({});
  const payload = JSON.parse(r.content[0].text);
  assert.equal(r.isError, true);
  assert.equal(payload.status, 406);
  assert.match(payload.hint, /tool defect, not a missed breakpoint/);
});

test("adt_debug_listen: a debuggee that already resumed is reported, not silently attached (#101)", async () => {
  _internals.SESSION.attached = null;
  const { ctx } = makeCtx([
    { match: (c) => c.path.endsWith("/listeners"), reply: { text: DEBUGGEE_XML } },
    {
      match: (c) => c.query?.method === "attach",
      reply: {
        ok: false,
        status: 500,
        text: '<exc:exception><properties><entry key="com.sap.adt.communicationFramework.subType">invalidDebuggee</entry></properties></exc:exception>',
      },
    },
  ]);
  const r = await register(ctx).adt_debug_listen({});
  const payload = JSON.parse(r.content[0].text);
  assert.equal(payload.caught, true);
  assert.equal(payload.attached, false);
  assert.match(payload.note, /already resumed/i);
  assert.equal(_internals.SESSION.attached, null, "a failed attach must not claim a session");
});

test("noSessionAttached is answered with the recovery step (#101)", async () => {
  const { ctx } = makeCtx([
    {
      match: (c) => c.path.endsWith("/stack"),
      reply: {
        ok: false,
        status: 404,
        text: '<exc:exception><properties><entry key="com.sap.adt.communicationFramework.subType">noSessionAttached</entry></properties></exc:exception>',
      },
    },
  ]);
  const r = await register(ctx).adt_debug_stack({});
  const payload = JSON.parse(r.content[0].text);
  assert.equal(payload.status, 404);
  assert.match(payload.hint, /adt_debug_listen/);
});

test("adt_debug_listen: timeout → caught:false, call-again note (not an error)", async () => {
  const { ctx } = makeCtx([
    {
      match: (c) => c.path.endsWith("/listeners"),
      throw: new Error("ADT request timed out after 30000ms: POST /sap/bc/adt/debugger/listeners"),
    },
  ]);
  const h = register(ctx);
  const r = await h.adt_debug_listen({});
  const payload = JSON.parse(r.content[0].text);
  assert.equal(payload.caught, false);
  assert.match(payload.note, /call adt_debug_listen again/i);
});

test("adt_debug_listen: a listener conflict is reported, not thrown", async () => {
  const { ctx } = makeCtx([
    {
      match: (c) => c.path.endsWith("/listeners"),
      reply: { text: "<exc:exception><localizedMessage>Debug session already active</localizedMessage></exc:exception>" },
    },
  ]);
  const h = register(ctx);
  const r = await h.adt_debug_listen({});
  const payload = JSON.parse(r.content[0].text);
  assert.equal(payload.caught, false);
  assert.match(payload.conflict, /already active/);
});

test("adt_debug_stack parses stack entries", async () => {
  const stackXml =
    '<dbg:stack xmlns:dbg="http://www.sap.com/adt/debugger">' +
    '<dbg:stackEntry uri="/sap/bc/adt/programs/programs/zfoo/source/main#start=5" line="5" programName="ZFOO" type="ABAP"/>' +
    '<dbg:stackEntry uri="/sap/bc/adt/oo/classes/zcl_bar/source/main#start=12" line="12" programName="ZCL_BAR" type="METHOD"/>' +
    "</dbg:stack>";
  const { ctx, calls } = makeCtx([{ match: (c) => c.path.endsWith("/stack"), reply: { text: stackXml } }]);
  const h = register(ctx);
  const r = await h.adt_debug_stack({});
  const payload = JSON.parse(r.content[0].text);
  assert.equal(calls[0].query.method, "getStack");
  assert.equal(payload.depth, 2);
  assert.equal(payload.stack[0].programName, "ZFOO");
  assert.equal(payload.stack[1].line, "12");
});

test("adt_debug_variables builds the getVariables body and parses values", async () => {
  const varsXml =
    '<asx:abap xmlns:asx="http://www.sap.com/abapxml"><asx:values><DATA>' +
    "<STPDA_ADT_VARIABLE><ID>sy-subrc</ID><NAME>SY-SUBRC</NAME><VALUE>0</VALUE></STPDA_ADT_VARIABLE>" +
    "<STPDA_ADT_VARIABLE><ID>lv_total</ID><NAME>LV_TOTAL</NAME><VALUE>42</VALUE></STPDA_ADT_VARIABLE>" +
    "</DATA></asx:values></asx:abap>";
  const { ctx, calls } = makeCtx([{ match: (c) => c.query?.method === "getVariables", reply: { text: varsXml } }]);
  const h = register(ctx);
  const r = await h.adt_debug_variables({ names: ["sy-subrc", "lv_total"] });
  const payload = JSON.parse(r.content[0].text);
  assert.match(calls[0].body, /<ID>sy-subrc<\/ID>/);
  assert.match(calls[0].body, /<ID>lv_total<\/ID>/);
  assert.equal(payload.variables.length, 2);
  assert.equal(payload.variables[0].VALUE, "0");
  assert.equal(payload.variables[1].NAME, "LV_TOTAL");
});

test("adt_debug_stop deletes the listener and tracked breakpoints", async () => {
  _internals.SESSION.breakpoints = [{ id: "BP-1", uri: "u" }, { id: "BP-2", uri: "u2" }];
  _internals.SESSION.attached = null;
  const { ctx, calls } = makeCtx([{ match: () => true, reply: { text: "" } }]);
  const h = register(ctx);
  const r = await h.adt_debug_stop({});
  const payload = JSON.parse(r.content[0].text);
  const deletes = calls.filter((c) => c.method === "DELETE");
  assert.ok(deletes.some((c) => c.path.endsWith("/listeners")), "listener deleted");
  assert.equal(deletes.filter((c) => /\/breakpoints\//.test(c.path)).length, 2, "both breakpoints deleted");
  assert.deepEqual(payload.breakpointsDeleted, ["BP-1", "BP-2"]);
  assert.deepEqual(_internals.SESSION.breakpoints, []);
});

test("adt_debug_stop releases an attached debuggee before cleaning up (#101)", async () => {
  _internals.SESSION.breakpoints = [];
  _internals.SESSION.attached = "DBG-9";
  const { ctx, calls } = makeCtx([{ match: () => true, reply: { text: "" } }]);
  const r = await register(ctx).adt_debug_stop({});
  assert.equal(calls[0].query.method, "stepContinue", "the suspended request is resumed first");
  assert.equal(calls[0].headers["X-sap-adt-sessiontype"], "stateful");
  assert.equal(JSON.parse(r.content[0].text).debuggee, "continued");
  assert.equal(_internals.SESSION.attached, null);

  // Read-only can't step; say so instead of leaving the caller guessing.
  _internals.SESSION.attached = "DBG-9";
  const ro = makeCtx([{ match: () => true, reply: { text: "" } }], { profile: { user: "DEV", readOnly: true } });
  const r2 = await register(ro.ctx).adt_debug_stop({});
  assert.equal(ro.calls.some((c) => c.query?.method === "stepContinue"), false);
  assert.match(JSON.parse(r2.content[0].text).debuggee, /read-only/);
});

test("requestUser gating: another user is refused unless the system opts in", async () => {
  const { ctx, calls } = makeCtx([{ match: () => true, reply: { text: BP_XML } }], { profile: { user: "DEV" } });
  const h = register(ctx);
  const r = await h.adt_debug_set_breakpoint({ object: "ZFOO", type: "program", line: 5, requestUser: "OTHER" });
  assert.match(r.content[0].text, /refusing to debug another user/);
  assert.equal(calls.length, 0);
});

test("requestUser gating: allowed when debugAllowRequestUser is set", async () => {
  const { ctx, calls } = makeCtx([{ match: () => true, reply: { text: BP_XML } }], {
    profile: { user: "DEV", debugAllowRequestUser: true },
  });
  const h = register(ctx);
  await h.adt_debug_set_breakpoint({ object: "ZFOO", type: "program", line: 5, requestUser: "OTHER" });
  assert.equal(calls.length, 1);
  assert.match(calls[0].body, /requestUser="OTHER"/);
});

// ── Phase 2 — flow control ──────────────────────────────────────────────────

const STEP_XML = '<dbg:step xmlns:dbg="http://www.sap.com/adt/debugger" isSteppingPossible="true"><actions><action name="stepInto"/></actions></dbg:step>';

test("adt_debug_step maps friendly kinds to ADT DebugStepType", async () => {
  const { ctx, calls } = makeCtx([{ match: (c) => c.path === "/sap/bc/adt/debugger", reply: { text: STEP_XML } }]);
  const h = register(ctx);
  await h.adt_debug_step({ kind: "over" });
  assert.equal(calls[0].query.method, "stepOver");
  await h.adt_debug_step({ kind: "continue" });
  assert.equal(calls[1].query.method, "stepContinue");
  await h.adt_debug_step({ kind: "terminate" });
  assert.equal(calls[2].query.method, "terminateDebuggee");
});

test("adt_debug_step: a continue that finishes the run is success, not an error (#101)", async () => {
  // Verified live: stepContinue on a debuggee that nothing else traps lets the
  // ABAP session finish before ADT can answer, so the step comes back as
  // 500 SY/530 debuggeeEnded — while the triggering HTTP request returns 200.
  _internals.SESSION.attached = "DBG-9";
  const { ctx } = makeCtx([
    {
      match: (c) => c.query?.method === "stepContinue",
      reply: {
        ok: false,
        status: 500,
        text:
          '<exc:exception><type id="AdiFailed"/><message lang="EN">An exception was raised</message>' +
          '<properties><entry key="com.sap.adt.communicationFramework.subType">debuggeeEnded</entry></properties></exc:exception>',
      },
    },
  ]);
  const r = await register(ctx).adt_debug_step({ kind: "continue" });
  const payload = JSON.parse(r.content[0].text);
  assert.notEqual(r.isError, true, "a completed run must not be reported as a failure");
  assert.equal(payload.status, "debuggeeEnded");
  assert.match(payload.note, /ran to completion/);
  assert.equal(_internals.SESSION.attached, null);
});

test("adt_debug_step: runToLine requires a uri; unknown kind rejected", async () => {
  const { ctx, calls } = makeCtx([{ match: () => true, reply: { text: STEP_XML } }]);
  const h = register(ctx);
  const r1 = await h.adt_debug_step({ kind: "runToLine" });
  assert.match(r1.content[0].text, /requires `uri`/);
  const r2 = await h.adt_debug_step({ kind: "sideways" });
  assert.match(r2.content[0].text, /unknown kind/);
  assert.equal(calls.length, 0);
});

test("adt_debug_step is refused under read-only", async () => {
  const { ctx, calls } = makeCtx([{ match: () => true, reply: { text: STEP_XML } }], { profile: { user: "DEV", readOnly: true } });
  const h = register(ctx);
  const r = await h.adt_debug_step({ kind: "over" });
  assert.match(r.content[0].text, /read-only/i);
  assert.equal(calls.length, 0);
});

test("adt_debug_goto_stack validates the stack URI and accepts a position", async () => {
  const { ctx, calls } = makeCtx([{ match: () => true, reply: { text: "" } }]);
  const h = register(ctx);
  const bad = await h.adt_debug_goto_stack({ stackUri: "/sap/bc/adt/debugger/nope" });
  assert.match(bad.content[0].text, /stackUri must look like/);

  await h.adt_debug_goto_stack({ stackUri: "/sap/bc/adt/debugger/stack/type/ABAP/position/2" });
  assert.equal(calls[0].method, "PUT");

  await h.adt_debug_goto_stack({ position: 1 });
  assert.equal(calls[1].query.method, "setStackPosition");
  assert.equal(calls[1].query.position, 1);
});

// ── Phase 3 — value writes ──────────────────────────────────────────────────

test("adt_debug_set_variable POSTs setVariableValue with the value as body", async () => {
  const { ctx, calls } = makeCtx([{ match: (c) => c.query?.method === "setVariableValue", reply: { text: "<ok/>" } }]);
  const h = register(ctx);
  await h.adt_debug_set_variable({ name: "lv_total", value: "99" });
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].query.variableName, "lv_total");
  assert.equal(calls[0].body, "99");
});

test("adt_debug_set_variable is refused under read-only", async () => {
  const { ctx, calls } = makeCtx([{ match: () => true, reply: { text: "<ok/>" } }], { profile: { user: "DEV", readOnly: true } });
  const h = register(ctx);
  const r = await h.adt_debug_set_variable({ name: "x", value: "1" });
  assert.match(r.content[0].text, /read-only/i);
  assert.equal(calls.length, 0);
});

test("adt_debug_set_watchpoint sends variableName and is read-only gated", async () => {
  const wpXml = '<dbg:watchpoints xmlns:dbg="http://www.sap.com/adt/debugger"><dbg:watchpoint id="WP-1" variableName="LV_X"/></dbg:watchpoints>';
  const { ctx, calls } = makeCtx([{ match: (c) => c.path.endsWith("/watchpoints"), reply: { text: wpXml } }]);
  const h = register(ctx);
  const r = await h.adt_debug_set_watchpoint({ variableName: "lv_x", condition: "lv_x > 10" });
  const payload = JSON.parse(r.content[0].text);
  assert.equal(calls[0].query.variableName, "lv_x");
  assert.equal(calls[0].query.condition, "lv_x > 10");
  assert.equal(payload.watchpoints[0].id, "WP-1");

  const ro = makeCtx([{ match: () => true, reply: { text: wpXml } }], { profile: { user: "DEV", readOnly: true } });
  const r2 = await register(ro.ctx).adt_debug_set_watchpoint({ variableName: "x" });
  assert.match(r2.content[0].text, /read-only/i);
  assert.equal(ro.calls.length, 0);
});
