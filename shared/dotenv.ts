// shared/dotenv.ts — reading and writing the dotenv text that sops decrypts
// `*.env` files to, line for line the way sops itself does.
//
// What: turns decrypted dotenv text into rows (settings and comments) for the
// table view, back into text, and checks rows for mistakes.
//
// Why: the table view edits rows, but sops is what finally reads the text.
// If this file and sops disagreed about what a line means, a save could
// change or drop a setting the user never touched.
//
// Design notes (each checked against sops 3.13 with a throwaway key):
// - A line is a comment when it starts with `#`, a setting when it has an
//   `=`, and blank when it is only whitespace. sops drops blank lines on
//   encrypt, so they are not kept as rows. Any other line is an error: sops
//   refuses the whole file.
// - The name is everything before the first `=`, taken literally (spaces and
//   an `export ` prefix included), and the value is everything after it, also
//   literally: quotes are kept as typed, and `\n` stays the two characters
//   backslash and n. Nothing here unquotes or unescapes, so text survives a
//   round trip through the table unchanged.
// - sops accepts an empty name and repeated names; both are almost always a
//   mistake, so `checkRows` reports an empty name as an error (blocks saving)
//   and a repeated or unusual name as a warning (does not).
//
// Gotchas:
// - The rows' `id`s are only for React keys; they are not stable across
//   parses and carry no meaning.

/** One line of a decrypted dotenv file. */
export type DotenvRow =
  | { id: string; kind: "setting"; name: string; value: string }
  | { id: string; kind: "comment"; text: string };

/** A line sops would refuse, with its 1-based line number. */
export interface DotenvLineError {
  line: number;
  text: string;
}

/** The result of reading dotenv text: rows, or the lines sops would refuse. */
export type DotenvParse =
  | { ok: true; rows: DotenvRow[] }
  | { ok: false; errors: DotenvLineError[] };

let nextRowId = 0;

/** A fresh row id, unique within this page load. */
export function newRowId(): string {
  nextRowId += 1;
  return `row-${nextRowId}`;
}

/**
 * Reads decrypted dotenv text into rows.
 *
 * @param text Text as sops prints it, or as the user typed it.
 * @returns The rows in file order, or every line sops would refuse.
 */
export function parseDotenv(text: string): DotenvParse {
  const rows: DotenvRow[] = [];
  const errors: DotenvLineError[] = [];
  const lines = text.split("\n");
  lines.forEach((raw, index) => {
    // A Windows line ending is not part of the value as far as a reader of
    // the table is concerned; sops itself would keep the \r, but no setting
    // is meant to end in one.
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line.trim() === "") return;
    if (line.startsWith("#")) {
      rows.push({ id: newRowId(), kind: "comment", text: line.slice(1) });
      return;
    }
    const equals = line.indexOf("=");
    if (equals === -1) {
      errors.push({ line: index + 1, text: line });
      return;
    }
    rows.push({
      id: newRowId(),
      kind: "setting",
      name: line.slice(0, equals),
      value: line.slice(equals + 1),
    });
  });
  return errors.length > 0 ? { ok: false, errors } : { ok: true, rows };
}

/**
 * Writes rows back to dotenv text, one line each, ending in a newline (what
 * sops prints). No rows gives the empty string.
 */
export function serializeDotenv(rows: readonly DotenvRow[]): string {
  if (rows.length === 0) return "";
  return (
    rows
      .map((row) =>
        row.kind === "comment" ? `#${row.text}` : `${row.name}=${row.value}`,
      )
      .join("\n") + "\n"
  );
}

/**
 * The text sops would store for this dotenv text: blank lines dropped and a
 * final newline. Used to tell a real change from one sops would undo.
 */
export function normalizeDotenv(text: string): string {
  const parsed = parseDotenv(text);
  return parsed.ok ? serializeDotenv(parsed.rows) : text;
}

/** A problem with one row. Errors block saving; warnings do not. */
export interface RowProblem {
  severity: "error" | "warning";
  message: string;
}

/** Names a shell, Docker Compose and most programs accept without trouble. */
const PLAIN_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Checks rows for mistakes before saving.
 *
 * @returns A map from row id to its problem; rows without one are absent.
 *   A setting with an empty name, or with a line break in its name or
 *   value, is an error. A name used twice, or one with spaces or other
 *   unusual characters, is a warning.
 */
export function checkRows(rows: readonly DotenvRow[]): Map<string, RowProblem> {
  const problems = new Map<string, RowProblem>();
  const seen = new Map<string, number>();
  for (const row of rows) {
    if (row.kind === "setting") seen.set(row.name, (seen.get(row.name) ?? 0) + 1);
  }
  for (const row of rows) {
    if (row.kind === "comment") {
      if (row.text.includes("\n")) {
        problems.set(row.id, {
          severity: "error",
          message: "A comment cannot span lines.",
        });
      }
      continue;
    }
    if (row.name === "") {
      problems.set(row.id, { severity: "error", message: "Give this setting a name." });
    } else if (row.name.includes("\n") || row.value.includes("\n")) {
      problems.set(row.id, {
        severity: "error",
        message: "A name or value cannot contain a line break; write \\n instead.",
      });
    } else if ((seen.get(row.name) ?? 0) > 1) {
      problems.set(row.id, {
        severity: "warning",
        message: "This name is used more than once; most programs keep only the last.",
      });
    } else if (!PLAIN_NAME.test(row.name)) {
      problems.set(row.id, {
        severity: "warning",
        message:
          "Unusual name: spaces and symbols are kept as typed, which most programs do not expect.",
      });
    }
  }
  return problems;
}

/** One difference between two versions of a dotenv file, by name. */
export type DotenvChange =
  | { kind: "added"; name: string; value: string }
  | { kind: "removed"; name: string; value: string }
  | { kind: "changed"; name: string; before: string; after: string };

/**
 * Lists the settings added, removed and changed between two dotenv texts,
 * for the review before saving. Comments are left out: they hold no
 * secrets and their changes are shown as a count by the caller.
 *
 * When a name appears more than once, its last value is compared, which is
 * the one most programs use.
 */
export function diffDotenv(before: string, after: string): DotenvChange[] {
  const read = (text: string): Map<string, string> => {
    const parsed = parseDotenv(text);
    const values = new Map<string, string>();
    if (!parsed.ok) return values;
    for (const row of parsed.rows) {
      if (row.kind === "setting") values.set(row.name, row.value);
    }
    return values;
  };
  const old = read(before);
  const next = read(after);
  const changes: DotenvChange[] = [];
  for (const [name, value] of next) {
    const previous = old.get(name);
    if (previous === undefined) changes.push({ kind: "added", name, value });
    else if (previous !== value) {
      changes.push({ kind: "changed", name, before: previous, after: value });
    }
  }
  for (const [name, value] of old) {
    if (!next.has(name)) changes.push({ kind: "removed", name, value });
  }
  return changes;
}
