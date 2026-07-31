import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCreateRequest, mediaTypeFallbacks, postCreate } from "../src/object-create.js";

test("missing name or package throws", () => {
  assert.throws(() => buildCreateRequest({ type: "class" }), /name/);
  assert.throws(
    () => buildCreateRequest({ type: "class", name: "ZCL_X" }),
    /package/
  );
});

test("unsupported type throws with hint", () => {
  assert.throws(
    () => buildCreateRequest({ type: "tabl", name: "ZX", package: "ZP" }),
    /not supported/
  );
});

test("class create posts to oo/classes with v3 content type", () => {
  const r = buildCreateRequest({
    type: "class",
    name: "zcl_alpha",
    package: "zlocal",
    description: "Alpha class",
  });
  assert.equal(r.path, "/sap/bc/adt/oo/classes");
  assert.match(r.contentType, /oo\.classes\.v3\+xml/);
  assert.match(r.body, /adtcore:name="ZCL_ALPHA"/);
  assert.match(r.body, /adtcore:type="CLAS\/OC"/);
  assert.match(r.body, /adtcore:packageRef adtcore:name="ZLOCAL"/);
  assert.match(r.body, /adtcore:description="Alpha class"/);
});

test("interface create posts to oo/interfaces", () => {
  const r = buildCreateRequest({
    type: "interface",
    name: "ZIF_X",
    package: "ZPKG",
  });
  assert.equal(r.path, "/sap/bc/adt/oo/interfaces");
  assert.match(r.body, /adtcore:type="INTF\/OI"/);
});

test("program create defaults to executableProgram type", () => {
  const r = buildCreateRequest({
    type: "program",
    name: "ZHELLO",
    package: "ZPKG",
  });
  assert.equal(r.path, "/sap/bc/adt/programs/programs");
  assert.match(r.body, /program:programType="executableProgram"/);
});

test("program create accepts modulePool override", () => {
  const r = buildCreateRequest({
    type: "program",
    name: "ZHELLO",
    package: "ZPKG",
    programType: "modulePool",
  });
  assert.match(r.body, /program:programType="modulePool"/);
});

test("function module create needs group and posts under it", () => {
  assert.throws(
    () =>
      buildCreateRequest({
        type: "function",
        name: "Z_FM",
        package: "ZPKG",
      }),
    /group/
  );
  const r = buildCreateRequest({
    type: "function",
    name: "Z_FM",
    package: "ZPKG",
    group: "ZGROUP",
  });
  assert.equal(r.path, "/sap/bc/adt/functions/groups/zgroup/fmodules");
  assert.match(r.body, /adtcore:type="FUGR\/FF"/);
  assert.match(r.body, /containerRef[^>]*adtcore:name="ZGROUP"/);
  assert.match(r.body, /containerRef adtcore:uri="\/sap\/bc\/adt\/functions\/groups\/zgroup"/);
});

test("function module create percent-encodes a namespaced group everywhere (#100)", () => {
  const r = buildCreateRequest({
    type: "function",
    name: "/NSX/Z_FM",
    package: "/NSX/PKG",
    group: "/NSX/GRP",
  });
  // Both the POST target and the containerRef inside the body carry the group as
  // ONE encoded path segment. Leaving the slashes raw in the body produced
  // ".../groups//nsx/grp" — a resource that doesn't exist, hence the 500 (#100).
  assert.equal(r.path, "/sap/bc/adt/functions/groups/%2Fnsx%2Fgrp/fmodules");
  assert.match(r.body, /containerRef adtcore:uri="\/sap\/bc\/adt\/functions\/groups\/%2Fnsx%2Fgrp"/);
  assert.doesNotMatch(r.body, /groups\/\/nsx/);
  assert.match(r.body, /containerRef[^>]*adtcore:name="\/NSX\/GRP"/);
});

test("CDS / DCLS / DDLX / BDEF / MSAG endpoints route correctly", () => {
  assert.equal(
    buildCreateRequest({ type: "cds", name: "Z_V", package: "ZP" }).path,
    "/sap/bc/adt/ddic/ddl/sources"
  );
  assert.equal(
    buildCreateRequest({ type: "accesscontrol", name: "Z_AC", package: "ZP" }).path,
    "/sap/bc/adt/acm/dcls"
  );
  assert.equal(
    buildCreateRequest({ type: "metadataext", name: "Z_MX", package: "ZP" }).path,
    "/sap/bc/adt/ddic/ddlx/sources"
  );
  assert.equal(
    buildCreateRequest({ type: "behaviordef", name: "Z_BD", package: "ZP" }).path,
    "/sap/bc/adt/bo/behaviordefinitions"
  );
  assert.equal(
    buildCreateRequest({ type: "messageclass", name: "Z_MSG", package: "ZP" }).path,
    "/sap/bc/adt/messageclasses"
  );
});

test("description longer than 60 chars is truncated", () => {
  const long = "x".repeat(120);
  const r = buildCreateRequest({
    type: "class",
    name: "ZCL_X",
    package: "ZP",
    description: long,
  });
  const m = r.body.match(/adtcore:description="([^"]*)"/);
  assert.ok(m);
  assert.equal(m[1].length, 60);
});

test("XML special characters in description are escaped", () => {
  const r = buildCreateRequest({
    type: "class",
    name: "ZCL_X",
    package: "ZP",
    description: "A & B <C>",
  });
  assert.match(r.body, /adtcore:description="A &amp; B &lt;C&gt;"/);
});

test("responsible attribute included when provided", () => {
  const r = buildCreateRequest({
    type: "class",
    name: "ZCL_X",
    package: "ZP",
    responsible: "developer",
  });
  assert.match(r.body, /adtcore:responsible="DEVELOPER"/);
});

test("mediaTypeFallbacks walks versioned content types down to v1, then the wildcard", () => {
  assert.deepEqual(mediaTypeFallbacks("application/vnd.sap.adt.ddlsource.v2+xml"), [
    "application/vnd.sap.adt.ddlsource.v2+xml",
    "application/vnd.sap.adt.ddlsource.v1+xml",
    "application/*",
  ]);
  assert.deepEqual(mediaTypeFallbacks("application/vnd.sap.adt.oo.classes.v3+xml"), [
    "application/vnd.sap.adt.oo.classes.v3+xml",
    "application/vnd.sap.adt.oo.classes.v2+xml",
    "application/vnd.sap.adt.oo.classes.v1+xml",
    "application/*",
  ]);
});

test("mediaTypeFallbacks appends the wildcard to unversioned types, without duplicating it", () => {
  assert.deepEqual(mediaTypeFallbacks("text/plain"), ["text/plain", "application/*"]);
  assert.deepEqual(mediaTypeFallbacks("application/vnd.sap.adt.foo+xml"), [
    "application/vnd.sap.adt.foo+xml",
    "application/*",
  ]);
  // The wildcard itself is its own single-item chain (no application/*, application/*).
  assert.deepEqual(mediaTypeFallbacks("application/*"), ["application/*"]);
});

test("postCreate retries with a lower media-type version on 415", async () => {
  const attempts = [];
  const client = {
    async request({ headers }) {
      attempts.push(headers["Content-Type"]);
      const is415 = headers["Content-Type"].includes(".v2+xml");
      return {
        ok: !is415,
        status: is415 ? 415 : 201,
        async text() {
          return is415 ? "Unsupported Media Type" : "<created/>";
        },
      };
    },
  };
  const { res, text, contentType } = await postCreate(client, {
    path: "/sap/bc/adt/ddic/ddl/sources",
    contentType: "application/vnd.sap.adt.ddlsource.v2+xml",
    body: "<ddl/>",
  });
  assert.deepEqual(attempts, [
    "application/vnd.sap.adt.ddlsource.v2+xml",
    "application/vnd.sap.adt.ddlsource.v1+xml",
  ]);
  assert.equal(res.status, 201);
  assert.equal(res.ok, true);
  assert.equal(text, "<created/>");
  assert.equal(contentType, "application/vnd.sap.adt.ddlsource.v1+xml");
});

test("postCreate stops at the first non-415 response", async () => {
  const attempts = [];
  const client = {
    async request({ headers }) {
      attempts.push(headers["Content-Type"]);
      return { ok: true, status: 201, async text() { return "ok"; } };
    },
  };
  const { res } = await postCreate(client, {
    path: "/x",
    contentType: "application/vnd.sap.adt.oo.classes.v3+xml",
    body: "<x/>",
  });
  assert.deepEqual(attempts, ["application/vnd.sap.adt.oo.classes.v3+xml"]);
  assert.equal(res.status, 201);
});

test("postCreate returns the last 415 when every version AND the wildcard are rejected", async () => {
  const attempts = [];
  const client = {
    async request({ headers }) {
      attempts.push(headers["Content-Type"]);
      return { ok: false, status: 415, async text() { return "nope"; } };
    },
  };
  const { res, contentType } = await postCreate(client, {
    path: "/x",
    contentType: "application/vnd.sap.adt.ddlsource.v2+xml",
    body: "<x/>",
  });
  assert.deepEqual(attempts, [
    "application/vnd.sap.adt.ddlsource.v2+xml",
    "application/vnd.sap.adt.ddlsource.v1+xml",
    "application/*",
  ]);
  assert.equal(res.status, 415);
  assert.equal(contentType, "application/*");
});

test("postCreate: the wildcard rescues a system that 415s every versioned type (#64)", async () => {
  // The #64 system rejected both ddlsource.v2 and .v1 with 415; ADT's create
  // framework still honours application/*, so the create must ultimately succeed.
  const attempts = [];
  const client = {
    async request({ headers }) {
      const ct = headers["Content-Type"];
      attempts.push(ct);
      const ok = ct === "application/*";
      return {
        ok,
        status: ok ? 201 : 415,
        async text() {
          return ok ? "<created/>" : "Unsupported Media Type";
        },
      };
    },
  };
  const { res, contentType } = await postCreate(client, {
    path: "/sap/bc/adt/ddic/ddl/sources",
    contentType: "application/vnd.sap.adt.ddlsource.v2+xml",
    body: "<ddl/>",
  });
  assert.deepEqual(attempts, [
    "application/vnd.sap.adt.ddlsource.v2+xml",
    "application/vnd.sap.adt.ddlsource.v1+xml",
    "application/*",
  ]);
  assert.equal(res.status, 201);
  assert.equal(contentType, "application/*");
});

test("postCreate: 400 ExceptionInvalidData also walks down the version chain", async () => {
  // Function-group create on SAP_BASIS 755: the v3 media type is accepted by
  // content negotiation but its schema doesn't match the body, so the server
  // answers 400 "Data is invalid and could not be converted". The identical body
  // succeeds as v2. A 415-only fallback left the tool permanently broken.
  const attempts = [];
  const client = {
    async request({ headers }) {
      const ct = headers["Content-Type"];
      attempts.push(ct);
      const ok = ct === "application/vnd.sap.adt.functions.groups.v2+xml";
      return {
        ok,
        status: ok ? 200 : 400,
        async text() {
          return ok
            ? "<created/>"
            : '<exc:exception><type id="ExceptionInvalidData"/><message lang="EN">Data is invalid and could not be converted</message></exc:exception>';
        },
      };
    },
  };
  const { res, contentType } = await postCreate(client, {
    path: "/sap/bc/adt/functions/groups",
    contentType: "application/vnd.sap.adt.functions.groups.v3+xml",
    body: "<group/>",
  });
  assert.deepEqual(attempts, [
    "application/vnd.sap.adt.functions.groups.v3+xml",
    "application/vnd.sap.adt.functions.groups.v2+xml",
  ]);
  assert.equal(res.status, 200);
  assert.equal(contentType, "application/vnd.sap.adt.functions.groups.v2+xml");
});

test("postCreate: a 400 that is NOT a media-type mismatch is returned as-is", async () => {
  const attempts = [];
  const client = {
    async request({ headers }) {
      attempts.push(headers["Content-Type"]);
      return {
        ok: false,
        status: 400,
        async text() {
          return '<exc:exception><type id="ExceptionResourceCreationFailure"/></exc:exception>';
        },
      };
    },
  };
  const { res } = await postCreate(client, {
    path: "/x",
    contentType: "application/vnd.sap.adt.oo.classes.v3+xml",
    body: "<x/>",
  });
  assert.equal(attempts.length, 1, "no pointless retries on a real request error");
  assert.equal(res.status, 400);
});
