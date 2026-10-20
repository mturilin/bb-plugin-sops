// End-to-end tests for server/sops.ts against the real sops and age
// programs, with a throwaway key in a temporary folder. Skipped when sops or
// age-keygen is not installed (this repo's mise.toml pins both).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { useRealPrograms } from "./test-tools.ts";

import { decryptSops, resolveSopsRef, saveSops, scanSopsFolder } from "./sops.ts";
import { sha256 } from "./files.ts";

const programs = { sops: "", mise: "", useMise: false };
let folder = "";
let skip: string | false = false;

before(async () => {
  const missing = useRealPrograms(["sops", "age-keygen"]);
  if (missing !== null) {
    skip = missing;
    return;
  }
  folder = await mkdtemp(join(tmpdir(), "bb-sops-test-"));
  execFileSync("age-keygen", ["-o", join(folder, "key.txt")], { stdio: "ignore" });
  const recipient = execFileSync("age-keygen", ["-y", join(folder, "key.txt")]).toString().trim();
  process.env.SOPS_AGE_KEY_FILE = join(folder, "key.txt");
  await writeFile(
    join(folder, ".sops.yaml"),
    `creation_rules:\n  - path_regex: \\.(env|yaml|json)$\n    age: ${recipient}\n`,
  );
  await writeFile(join(folder, "app.sops.env"), "# db\nUSER=admin\nPASS=hunter2\n");
  await writeFile(join(folder, "conf.yaml"), "db:\n  password: s3cret\nport: 5432\n");
  await writeFile(join(folder, "plain.env"), "NOT=encrypted\n");
  for (const name of ["app.sops.env", "conf.yaml"]) {
    execFileSync("sops", ["--encrypt", "--in-place", join(folder, name)], { cwd: folder });
  }
});

after(async () => {
  if (folder !== "") await rm(folder, { recursive: true, force: true });
});

test("finds encrypted files by content, not plain ones", async (t) => {
  if (skip) return t.skip(skip);
  const { files } = await scanSopsFolder(folder);
  assert.deepEqual(files.map((f) => f.ref.path), ["app.sops.env", "conf.yaml"]);
  const env = files[0]!;
  assert.equal(env.format, "dotenv");
  assert.equal(env.settingCount, 2);
  assert.equal(env.recipients.length, 1);
});

test("refuses paths outside the folder or not listed", async (t) => {
  if (skip) return t.skip(skip);
  await assert.rejects(resolveSopsRef({ root: folder, path: "../etc/passwd" }, [folder]));
  await assert.rejects(resolveSopsRef({ root: "/etc", path: "passwd" }, [folder]));
});

test("saves only changed values and keeps the rest of the ciphertext", async (t) => {
  if (skip) return t.skip(skip);
  const file = join(folder, "app.sops.env");
  const opened = await decryptSops(programs, file);
  assert.equal(opened.content, "# db\nUSER=admin\nPASS=hunter2\n");
  const before = await readFile(file, "utf8");
  const userLine = before.split("\n").find((l) => l.startsWith("USER="));

  const saved = await saveSops(programs, file, "# db\nUSER=admin\nPASS=correct horse\nNEW=1\n", opened.sha256);
  assert.equal(saved.outcome, "saved");
  const afterText = await readFile(file, "utf8");
  assert.ok(afterText.includes(userLine!), "unchanged value keeps its ciphertext");
  assert.equal((await decryptSops(programs, file)).content, "# db\nUSER=admin\nPASS=correct horse\nNEW=1\n");
});

test("reports unchanged text and refuses a stale hash", async (t) => {
  if (skip) return t.skip(skip);
  const file = join(folder, "app.sops.env");
  const opened = await decryptSops(programs, file);
  const same = await saveSops(programs, file, opened.content, opened.sha256);
  assert.equal(same.outcome, "unchanged");
  const stale = await saveSops(programs, file, "A=1\n", "0".repeat(64));
  assert.equal(stale.outcome, "conflict");
});

test("invalid text is refused and the file is left exactly as it was", async (t) => {
  if (skip) return t.skip(skip);
  const file = join(folder, "app.sops.env");
  const bytes = await readFile(file);
  await assert.rejects(saveSops(programs, file, "not a setting\n", sha256(bytes)), /Line 1/);
  assert.ok((await readFile(file)).equals(bytes));
});

test("YAML is saved and compared as data", async (t) => {
  if (skip) return t.skip(skip);
  const file = join(folder, "conf.yaml");
  const opened = await decryptSops(programs, file);
  const saved = await saveSops(programs, file, "db:\n    password: 'new'\nport: 5432\n", opened.sha256);
  assert.equal(saved.outcome, "saved");
  if (saved.outcome === "saved") assert.match(saved.content, /password: new/);
  await assert.rejects(
    saveSops(programs, file, "- just\n- a list\n", sha256(await readFile(file))),
    /mapping/,
  );
});
