// server/sops.ts — finding, decrypting and saving SOPS-encrypted files.
//
// What: scans a folder for files sops has encrypted, decrypts one to text,
// and saves edited text back through sops so the file keeps its keys.
//
// Why: the editor needs plaintext to show and a safe way back. Encrypting
// from scratch (`sops encrypt`) would make a new data key and re-encrypt
// every value; `sops edit` keeps the data key, the recipients and the
// unchanged values' ciphertext (tested with sops 3.13), so a git diff shows
// only the settings that changed.
//
// Design notes:
// - sops is run as `mise exec -- sops` in the file's folder when mise is
//   installed, so a repo's pinned sops version and its SOPS_AGE_KEY_FILE
//   (set in a `.mise.toml`) apply exactly as in a terminal there.
//   Without mise, sops runs as found.
// - Saving drives `sops edit` with an "editor" that is a one-line shell
//   command writing the new text (piped to sops' stdin, which sops passes on
//   to its editor) over sops' temporary file. The command works once only:
//   it creates a marker folder first and fails if it already exists. That
//   matters because when sops cannot parse the edited text it asks for a key
//   press and re-runs the editor; with no terminal, a second run would read
//   nothing and sops would save an empty file. A failing second run makes
//   sops give up with the file untouched.
// - After sops exits, the file is decrypted again and compared with what was
//   sent (server/check.ts). If they differ, the original encrypted bytes are
//   put back and the save is reported as failed.
// - Files are recognised by content (sops' metadata block), not by name,
//   so a `secrets.yaml` encrypted without a `.sops.` in its name is found
//   too. Only likely files are read: dotenv, YAML, JSON and INI files, and
//   any file with "sops" or ".enc" in its name, up to 1 MB each.
//
// Gotchas:
// - sops writes the plaintext to its own temporary file (mode 0600) while
//   "editing", exactly as `sops edit` in a terminal does. This plugin writes
//   none of its own.
// - Exit code 200 from `sops edit` means the text did not change.

import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { FileRef, SopsFileInfo } from "../shared/contract.ts";
import { sopsFormatFor, type FileFormat } from "../shared/formats.ts";
import { checkSyntax, sameContent } from "./check.ts";
import { insideFolder, listFolderFiles, sha256, utf8Text } from "./files.ts";
import { briefError, findProgram, run, type RunResult } from "./run.ts";

/** Paths to programs from the plugin's settings; empty means "find it". */
export interface SopsPrograms {
  sops: string;
  mise: string;
  useMise: boolean;
}

/** Largest file read while scanning, in bytes. */
const MAX_SCANNED_FILE = 1024 * 1024;

/** Extensions whose files may be SOPS-encrypted and are worth reading. */
const LIKELY_EXTENSIONS = /\.(env|ya?ml|json|ini)$/i;

/**
 * Whether file contents carry a SOPS metadata block, in any of the formats
 * sops writes.
 */
export function isSopsContent(text: string): boolean {
  // Every format sops writes holds ENC[…] values; files sops stores whole
  // ("binary" store) are JSON with the file in "data", caught by the JSON
  // test below.
  if (!text.includes("ENC[")) return false;
  return (
    // dotenv
    (/^sops_mac=/m.test(text) && /^sops_version=/m.test(text)) ||
    // YAML
    (/^sops:\s*$/m.test(text) && /^\s+mac:\s*ENC\[/m.test(text)) ||
    // JSON (also sops' binary store)
    (/"sops"\s*:\s*\{/.test(text) && /"mac"\s*:\s*"ENC\[/.test(text)) ||
    // INI
    (/^\[sops\]\s*$/m.test(text) && /^mac\s*=\s*ENC\[/m.test(text))
  );
}

/**
 * What can be learned about a SOPS file without decrypting it: the age keys
 * it is encrypted to, whether other key types are in use, and for dotenv
 * the number of settings (names are not encrypted).
 */
export function describeSopsContent(
  text: string,
  format: FileFormat,
): Pick<SopsFileInfo, "recipients" | "otherKeys" | "settingCount"> {
  const recipients = [...new Set(text.match(/age1[0-9a-z]{58}/g) ?? [])];
  const otherKeys =
    /^sops_(pgp|kms|gcp_kms|azure_kv|hc_vault)__/m.test(text) ||
    /\b(fp|arn|resource_id|vault_address|vaultUrl)\b["']?\s*[:=]/.test(text);
  let settingCount: number | null = null;
  if (format === "dotenv") {
    settingCount = text
      .split("\n")
      .filter((line) => !line.startsWith("#") && line.includes("=") && !line.startsWith("sops_"))
      .length;
  }
  return { recipients, otherKeys, settingCount };
}

/**
 * Finds the SOPS files in a folder.
 *
 * @returns Their descriptions, sorted by path, and whether the folder was
 *   too large to search completely.
 * Side effects: runs `git ls-files`; reads candidate files.
 */
export async function scanSopsFolder(
  root: string,
): Promise<{ files: SopsFileInfo[]; truncated: boolean }> {
  const { paths, truncated } = await listFolderFiles(root);
  const candidates = paths.filter((path) => {
    const name = basename(path).toLowerCase();
    return LIKELY_EXTENSIONS.test(name) || name.includes("sops") || name.includes(".enc");
  });
  const files: SopsFileInfo[] = [];
  // Read in small batches: fast on an SSD, without opening thousands of
  // files at once.
  for (let start = 0; start < candidates.length; start += 64) {
    const batch = candidates.slice(start, start + 64);
    const found = await Promise.all(
      batch.map(async (path): Promise<SopsFileInfo | null> => {
        const absolute = join(root, path);
        try {
          const info = await stat(absolute);
          if (!info.isFile() || info.size > MAX_SCANNED_FILE) return null;
          const text = await readFile(absolute, "utf8");
          if (!isSopsContent(text)) return null;
          const format = sopsFormatFor(path);
          return {
            ref: { root, path },
            format,
            ...describeSopsContent(text, format),
          };
        } catch {
          return null;
        }
      }),
    );
    for (const file of found) if (file !== null) files.push(file);
  }
  files.sort((a, b) => a.ref.path.localeCompare(b.ref.path));
  return { files, truncated };
}

/**
 * The command that runs sops for a file in `folder`: through mise when
 * available (so the folder's pinned version and key settings apply), else
 * sops directly.
 *
 * @throws When neither is installed, with a message saying so.
 */
async function sopsCommand(
  programs: SopsPrograms,
): Promise<{ command: string; prefix: string[] }> {
  const sopsOverride = programs.sops.trim();
  if (programs.useMise) {
    const mise = await findProgram("mise", programs.mise);
    if (mise !== null) {
      return { command: mise, prefix: ["exec", "--", sopsOverride || "sops"] };
    }
  }
  const sops = await findProgram("sops", sopsOverride);
  if (sops === null) {
    throw new Error(
      "sops is not installed on the machine BB runs on. Install it (for example with mise), or set its path in this plugin's settings.",
    );
  }
  return { command: sops, prefix: [] };
}

async function runSops(
  programs: SopsPrograms,
  file: string,
  args: string[],
  extra: { input?: string; env?: Record<string, string> } = {},
): Promise<RunResult> {
  const { command, prefix } = await sopsCommand(programs);
  return run(command, [...prefix, ...args], {
    cwd: dirname(file),
    input: extra.input,
    env: extra.env,
    timeoutMs: 30_000,
  });
}

/**
 * Resolves a SOPS reference to the real file, refusing anything outside its
 * folder or not encrypted by sops.
 *
 * @param allowedRoots Folders the server itself lists for this request.
 * @throws With a plain message when the reference is not acceptable.
 */
export async function resolveSopsRef(
  ref: FileRef,
  allowedRoots: readonly string[],
): Promise<string> {
  if (!allowedRoots.includes(ref.root)) {
    throw new Error(
      "That file is not in this thread's folder or one named in the plugin's settings.",
    );
  }
  const file = await insideFolder(ref.root, ref.path);
  if (file === null) throw new Error(`There is no file ${ref.path} in ${ref.root}.`);
  return file;
}

/**
 * Decrypts a SOPS file.
 *
 * @returns The plaintext, the SHA-256 of the encrypted bytes it came from,
 *   and the age keys it is encrypted to.
 * @throws When the file is not SOPS-encrypted or sops fails (no key, wrong
 *   key, sops missing), with sops' own explanation.
 */
export async function decryptSops(
  programs: SopsPrograms,
  file: string,
): Promise<{ content: string; sha256: string; recipients: string[]; format: FileFormat }> {
  const bytes = await readFile(file);
  const text = bytes.toString("utf8");
  if (!isSopsContent(text)) {
    throw new Error(`${basename(file)} is not encrypted by sops.`);
  }
  const format = sopsFormatFor(file);
  const result = await runSops(programs, file, ["--decrypt", file]);
  if (result.code !== 0) {
    throw new Error(briefError(result, `sops could not decrypt ${basename(file)}`));
  }
  return {
    content: utf8Text(result.stdoutBytes, file),
    sha256: sha256(bytes),
    recipients: describeSopsContent(text, format).recipients,
    format,
  };
}

/** Saves in progress, by file, so two saves of one file never overlap. */
const saving = new Map<string, Promise<unknown>>();

/**
 * Saves edited text into a SOPS file through `sops edit`.
 *
 * Pre-conditions: `file` came from `resolveSopsRef`.
 * Side effects: rewrites the encrypted file (only the changed values get new
 *   ciphertext); on a failed check, writes the original bytes back. Creates
 *   and removes a private temporary folder for the one-shot editor marker.
 * @returns "conflict" if the file changed since `expectedSha256`,
 *   "unchanged" if sops found nothing to change, else "saved" with the new
 *   hash and the text as it now decrypts.
 * @throws When the text does not parse, sops fails, or the result does not
 *   match the text sent (the original is restored first).
 */
export async function saveSops(
  programs: SopsPrograms,
  file: string,
  content: string,
  expectedSha256: string,
): Promise<
  | { outcome: "saved"; sha256: string; content: string }
  | { outcome: "unchanged"; sha256: string }
  | { outcome: "conflict" }
> {
  const previous = saving.get(file) ?? Promise.resolve();
  const task = previous.catch(() => {}).then(() =>
    saveSopsNow(programs, file, content, expectedSha256),
  );
  saving.set(file, task);
  try {
    return await task;
  } finally {
    if (saving.get(file) === task) saving.delete(file);
  }
}

async function saveSopsNow(
  programs: SopsPrograms,
  file: string,
  content: string,
  expectedSha256: string,
): Promise<
  | { outcome: "saved"; sha256: string; content: string }
  | { outcome: "unchanged"; sha256: string }
  | { outcome: "conflict" }
> {
  const format = sopsFormatFor(file);
  const problem = checkSyntax(format, content);
  if (problem !== null) throw new Error(problem);

  const original = await readFile(file);
  if (sha256(original) !== expectedSha256) return { outcome: "conflict" };
  if (!isSopsContent(original.toString("utf8"))) {
    throw new Error(`${basename(file)} is no longer encrypted by sops.`);
  }

  const scratch = await mkdtemp(join(tmpdir(), "bb-sops-"));
  try {
    // sops splits EDITOR into words and adds the temporary file's path:
    // $0 is the marker, $1 the file to fill. The marker path has no spaces
    // or quotes (mkdtemp under the system temp folder).
    const editor = `sh -c 'mkdir "$0" 2>/dev/null || exit 1; cat > "$1"' ${join(scratch, "once")}`;
    const result = await runSops(programs, file, [file], {
      input: content,
      // SOPS_EDITOR wins over EDITOR in sops, so both are set.
      env: { SOPS_EDITOR: editor, EDITOR: editor, VISUAL: editor },
    });
    const after = await readFile(file);
    if (result.code === 200) return { outcome: "unchanged", sha256: sha256(after) };
    if (result.code !== 0 || /Could not load tree/.test(result.stderr)) {
      if (!after.equals(original)) await writeFile(file, original);
      throw new Error(briefError(result, "sops could not save the file"));
    }
    const check = await runSops(programs, file, ["--decrypt", file]);
    if (check.code !== 0 || !sameContent(format, content, check.stdout)) {
      await writeFile(file, original);
      throw new Error(
        "sops saved something other than what you wrote, so the file was put back as it was. Nothing changed.",
      );
    }
    return { outcome: "saved", sha256: sha256(after), content: check.stdout };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
