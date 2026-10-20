// server/files.ts — finding files in a folder and keeping paths inside it.
//
// What: lists a folder's files the way git sees them (tracked plus
// untracked-but-not-ignored), and resolves a relative path inside a folder,
// refusing anything that leads out of it.
//
// Why: file references come back from the browser, so a path like
// `../../.ssh/id_ed25519` or a symlink pointing out of the repo must not
// reach sops.
//
// Design notes:
// - git's own listing skips node_modules, build output and everything else
//   .gitignore names, which keeps a scan of a large repo fast. A folder that
//   is not a git repository is walked by hand, skipping the usual dependency
//   folders, up to a fixed number of entries.
// - `insideFolder` compares real paths (symlinks resolved), so a link inside
//   the folder that points outside it is refused.

import { createHash } from "node:crypto";
import { readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { findProgram, run } from "./run.ts";

/** Most files a scan looks at; a bigger folder is reported as cut short. */
export const MAX_LISTED_FILES = 50_000;

const SKIPPED_FOLDERS = new Set([
  ".git",
  "node_modules",
  ".venv",
  "venv",
  "__pycache__",
  ".cache",
  ".next",
  ".turbo",
  "dist",
  "target",
]);

/**
 * Every file in a folder, as paths relative to it with `/` separators.
 *
 * @returns The paths, and whether the list was cut at MAX_LISTED_FILES.
 * Side effects: runs `git ls-files` in the folder when it is a repository.
 */
export async function listFolderFiles(
  root: string,
): Promise<{ paths: string[]; truncated: boolean }> {
  const git = await findProgram("git");
  if (git !== null) {
    const result = await run(
      git,
      ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      { cwd: root, timeoutMs: 20_000, maxOutputBytes: 64 * 1024 * 1024 },
    );
    if (result.code === 0) {
      const paths = [...new Set(result.stdout.split("\0").filter((p) => p !== ""))];
      return {
        paths: paths.slice(0, MAX_LISTED_FILES),
        truncated: paths.length > MAX_LISTED_FILES,
      };
    }
  }
  const paths: string[] = [];
  let truncated = false;
  async function walk(folder: string, prefix: string): Promise<void> {
    if (truncated) return;
    let entries;
    try {
      entries = await readdir(folder, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (paths.length >= MAX_LISTED_FILES) {
        truncated = true;
        return;
      }
      const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!SKIPPED_FOLDERS.has(entry.name)) await walk(join(folder, entry.name), path);
      } else if (entry.isFile()) {
        paths.push(path);
      }
    }
  }
  await walk(root, "");
  return { paths, truncated };
}

/**
 * The absolute path of `path` inside `root`, if it really is inside it and is
 * a regular file.
 *
 * @param root An absolute folder path.
 * @param path A path relative to `root`.
 * @returns The real absolute path, or null when the path is absolute, leads
 *   outside the folder (directly or through a symlink), or is not a file.
 */
export async function insideFolder(
  root: string,
  path: string,
): Promise<string | null> {
  if (isAbsolute(path) || path.includes("\0")) return null;
  try {
    const realRoot = await realpath(root);
    const realFile = await realpath(resolve(realRoot, path));
    const rel = relative(realRoot, realFile);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null;
    if (!realFile.startsWith(realRoot + sep)) return null;
    if (!(await stat(realFile)).isFile()) return null;
    return realFile;
  } catch {
    return null;
  }
}

/** Lowercase hex SHA-256 of some bytes. */
export function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** A path with the home folder written as `~`, for showing to the user. */
export function tildePath(path: string, home: string): string {
  return path === home || path.startsWith(home + sep)
    ? `~${path.slice(home.length)}`
    : path;
}

/**
 * Decrypted bytes as text, refusing anything that is not UTF-8: a text
 * editor would silently mangle binary content, and saving it would corrupt
 * the file.
 *
 * @throws When the bytes are not valid UTF-8.
 */
export function utf8Text(bytes: Buffer, file: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    const name = file.split("/").at(-1) ?? file;
    throw new Error(`${name} decrypts to binary data, which this editor cannot show safely.`);
  }
}
