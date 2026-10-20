// shared/refs.ts — checking a file reference read back from a saved panel
// tab, without zod.
//
// The browser needs this one check (tab parameters are untrusted), and
// pulling zod into the browser bundle for it would more than double the
// bundle's size. The server checks every reference again with the full
// schema in contract.ts.

import type { FileRef } from "./contract.ts";

const MAX_PATH = 4096;

function isPath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_PATH;
}

/** The value as a file reference when it has exactly the right shape, else null. */
export function asFileRef(value: unknown): FileRef | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== "path,root") return null;
  if (!isPath(record.root) || !isPath(record.path)) return null;
  return { root: record.root, path: record.path };
}
