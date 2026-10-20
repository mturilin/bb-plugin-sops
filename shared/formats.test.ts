// Tests for shared/formats.ts and shared/refs.ts: formats follow sops'
// last-extension rule, and only well-formed references pass the browser's
// check of saved tab parameters.
import assert from "node:assert/strict";
import { test } from "node:test";
import { sopsFormatFor } from "./formats.ts";
import { asFileRef } from "./refs.ts";

test("sops format comes from the last extension", () => {
  assert.equal(sopsFormatFor("stacks/abs/secrets.sops.env"), "dotenv");
  assert.equal(sopsFormatFor("a/b.sops.yaml"), "yaml");
  assert.equal(sopsFormatFor("a/b.yml"), "yaml");
  assert.equal(sopsFormatFor("x.json"), "json");
  assert.equal(sopsFormatFor("x.ini"), "ini");
  assert.equal(sopsFormatFor("cert.pem"), "text");
  assert.equal(sopsFormatFor(".env"), "text");
});

test("tab parameters only pass as a file reference with exactly the right shape", () => {
  assert.deepEqual(asFileRef({ root: "/r", path: "x.env" }), { root: "/r", path: "x.env" });
  assert.equal(asFileRef({ root: "/r", path: "x.env", extra: 1 }), null);
  assert.equal(asFileRef({ path: "x.env" }), null);
  assert.equal(asFileRef({ root: "/r", path: "" }), null);
  assert.equal(asFileRef("x.env"), null);
});
