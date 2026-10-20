// Tests for shared/dotenv.ts: rows must round-trip to exactly the text sops
// would store, and checks must flag the mistakes sops lets through.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  checkRows,
  diffDotenv,
  normalizeDotenv,
  parseDotenv,
  serializeDotenv,
} from "./dotenv.ts";

test("round-trips settings and comments literally", () => {
  const text = '# top\nA=1\nexport B="q u"\nC=x\\ny\n#no-space\nD=\nE=a=b\n';
  const parsed = parseDotenv(text);
  assert.ok(parsed.ok);
  assert.equal(serializeDotenv(parsed.rows), text);
});

test("drops blank lines and adds the final newline, as sops does", () => {
  assert.equal(normalizeDotenv("A=1\n\n  \nB=2"), "A=1\nB=2\n");
  assert.equal(normalizeDotenv(""), "");
});

test("keeps spaces around = as part of the name and value", () => {
  const parsed = parseDotenv("A = 1\n");
  assert.ok(parsed.ok);
  assert.deepEqual(
    parsed.rows.map((r) => (r.kind === "setting" ? [r.name, r.value] : null)),
    [["A ", " 1"]],
  );
});

test("reports lines sops would refuse", () => {
  const parsed = parseDotenv("A=1\nnot a setting\n# fine\n");
  assert.equal(parsed.ok, false);
  if (!parsed.ok) assert.deepEqual(parsed.errors, [{ line: 2, text: "not a setting" }]);
});

test("flags empty and repeated names", () => {
  const parsed = parseDotenv("=x\nA=1\nA=2\nB C=3\nOK_1=4\n");
  assert.ok(parsed.ok);
  const problems = checkRows(parsed.rows);
  const [empty, a1, a2, spaced, ok] = parsed.rows;
  assert.equal(problems.get(empty!.id)?.severity, "error");
  assert.equal(problems.get(a1!.id)?.severity, "warning");
  assert.equal(problems.get(a2!.id)?.severity, "warning");
  assert.equal(problems.get(spaced!.id)?.severity, "warning");
  assert.equal(problems.get(ok!.id), undefined);
});

test("lists added, changed and removed settings", () => {
  assert.deepEqual(diffDotenv("A=1\nB=2\n#c\n", "A=1\nB=3\nC=4\n"), [
    { kind: "changed", name: "B", before: "2", after: "3" },
    { kind: "added", name: "C", value: "4" },
  ]);
  assert.deepEqual(diffDotenv("A=1\n", ""), [{ kind: "removed", name: "A", value: "1" }]);
});
