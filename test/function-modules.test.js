import { test } from "node:test";
import assert from "node:assert/strict";

import {
  groupFromFunctionUri,
  resolveFunctionGroup,
  resolveGroup,
} from "../src/function-modules.js";

const hit = (name, group) => ({
  ok: true,
  status: 200,
  headers: { get: () => "application/xml" },
  text: async () =>
    '<adtcore:objectReferences xmlns:adtcore="http://www.sap.com/adt/core">' +
    `<adtcore:objectReference adtcore:uri="/sap/bc/adt/functions/groups/${group}/fmodules/${encodeURIComponent(name.toLowerCase())}"` +
    ` adtcore:name="${name}" adtcore:type="FUGR/FF"/>` +
    "</adtcore:objectReferences>",
});

const empty = {
  ok: true,
  status: 200,
  headers: { get: () => "application/xml" },
  text: async () => '<adtcore:objectReferences xmlns:adtcore="http://www.sap.com/adt/core"/>',
};

function fakeClient(response) {
  const calls = [];
  return {
    calls,
    request: async (call) => {
      calls.push(call);
      return response;
    },
  };
}

test("groupFromFunctionUri: extracts and decodes the owning group", () => {
  assert.equal(groupFromFunctionUri("/sap/bc/adt/functions/groups/v61a/fmodules/rv_price"), "v61a");
  assert.equal(
    groupFromFunctionUri("/sap/bc/adt/functions/groups/%2Ffglr%2Fdelivery/fmodules/x"),
    "/fglr/delivery"
  );
  assert.equal(groupFromFunctionUri("/sap/bc/adt/oo/classes/zcl_a"), undefined);
  assert.equal(groupFromFunctionUri(undefined), undefined);
});

test("resolveFunctionGroup: finds the group by object search — #104", async () => {
  const client = fakeClient(hit("/FGLR/FM_CREATE_GR_FR01", "%2Ffglr%2Fcreate"));
  const group = await resolveFunctionGroup(client, "/FGLR/FM_CREATE_GR_FR01");
  assert.equal(group, "/fglr/create");
  assert.equal(client.calls[0].query.objectType, "FUGR/FF");
  assert.equal(client.calls[0].query.query, "/FGLR/FM_CREATE_GR_FR01");
});

test("resolveFunctionGroup: a prefix match is not accepted as the module — #104", async () => {
  // quickSearch matches by prefix; borrowing the group of a different module
  // would silently read the wrong object.
  const client = fakeClient(hit("/FGLR/FM_CREATE_GR_FR01_OLD", "%2Ffglr%2Fother"));
  assert.equal(await resolveFunctionGroup(client, "/FGLR/FM_CREATE_GR_FR01"), undefined);
});

test("resolveFunctionGroup: no hit and transport failures degrade to undefined", async () => {
  assert.equal(await resolveFunctionGroup(fakeClient(empty), "Z_NOPE"), undefined);
  const boom = {
    request: async () => {
      throw new Error("socket hang up");
    },
  };
  assert.equal(await resolveFunctionGroup(boom, "Z_NOPE"), undefined);
  assert.equal(await resolveFunctionGroup(fakeClient(empty), ""), undefined);
});

test("resolveGroup: only a group-less function module triggers a lookup — #104", async () => {
  const supplied = fakeClient(hit("Z_FM", "zgrp"));
  assert.deepEqual(await resolveGroup(supplied, { type: "function", name: "Z_FM", group: "ZOTHER" }), {
    group: "ZOTHER",
  });
  assert.equal(supplied.calls.length, 0, "a supplied group is never second-guessed");

  const other = fakeClient(hit("Z_FM", "zgrp"));
  assert.deepEqual(await resolveGroup(other, { type: "class", name: "ZCL_A" }), { group: undefined });
  assert.equal(other.calls.length, 0, "non-function types don't take a group at all");

  const bare = fakeClient(hit("Z_FM", "zgrp"));
  assert.deepEqual(await resolveGroup(bare, { type: "function", name: "Z_FM" }), {
    group: "zgrp",
    resolvedGroup: true,
  });
});

test("resolveGroup: an unparseable type is left to the URI builder to reject", async () => {
  const client = fakeClient(empty);
  assert.deepEqual(await resolveGroup(client, { type: "", name: "Z_FM" }), { group: undefined });
  assert.equal(client.calls.length, 0);
});
