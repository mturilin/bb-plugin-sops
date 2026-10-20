// server/test-tools.ts — making sops and age usable from tests that
// run in throwaway folders.
//
// mise installs programs behind "shims" that pick a version from the
// current folder's mise config. The tests work in temporary folders with no
// config, where a shim refuses to run. So the real program paths are looked
// up once, from this repo's folder (its mise.toml pins sops and age), and
// put first on PATH for the rest of the test process.

import { execFileSync } from "node:child_process";
import { dirname } from "node:path";

/** Where a program really is, preferring mise's install over its shim. */
function realPath(program: string): string | null {
  for (const [command, args] of [
    ["mise", ["which", program]],
    ["sh", ["-c", `command -v ${program}`]],
  ] as const) {
    try {
      const path = execFileSync(command, args, { stdio: ["ignore", "pipe", "ignore"] })
        .toString()
        .trim();
      if (path !== "") return path;
    } catch {
      // try the next way
    }
  }
  return null;
}

/**
 * Puts the real folders of these programs first on PATH.
 *
 * @returns null when every program runs, else why the tests should skip.
 * Side effects: changes process.env.PATH for this test process.
 */
export function useRealPrograms(programs: readonly string[]): string | null {
  for (const program of programs) {
    const path = realPath(program);
    if (path === null) return `${program} is not installed`;
    process.env.PATH = `${dirname(path)}:${process.env.PATH ?? ""}`;
    try {
      execFileSync(path, ["--version"], { stdio: "ignore" });
    } catch {
      return `${program} does not run here`;
    }
  }
  return null;
}
