// server/check.ts — checking text before it is encrypted, and checking that
// what was encrypted is what the user wrote.
//
// What: `checkSyntax` refuses text that sops could not parse; `sameContent` compares the text sent with the
// text the saved file now decrypts to.
//
// Why: sops treats bad input badly. When `sops edit` cannot parse the new
// text it asks for a key press; with no terminal it re-runs the editor,
// which (tested with sops 3.13) can save an empty file. The editor guard in
// sops.ts stops that, and checking the syntax first means it should never be
// needed. Comparing after the save catches anything both miss.
//
// Design notes:
// - sops reformats YAML and JSON on the way through (indentation, quoting),
//   so those are compared as data, not as text. Dotenv is compared after the
//   normalisation sops applies (blank lines dropped). INI is compared line
//   by line ignoring spacing around `=`. Anything else must match exactly.
// - YAML and JSON must be a mapping at the top: sops refuses a bare list
//   or value.

import { isDeepStrictEqual } from "node:util";
import { parseAllDocuments, parse as parseYaml } from "yaml";
import { normalizeDotenv, parseDotenv } from "../shared/dotenv.ts";
import type { FileFormat } from "../shared/formats.ts";

/**
 * Checks that text parses in its format.
 *
 * @returns null when it is fine, else what is wrong, in plain words.
 */
export function checkSyntax(format: FileFormat, text: string): string | null {
  switch (format) {
    case "dotenv": {
      const parsed = parseDotenv(text);
      if (parsed.ok) return null;
      const first = parsed.errors[0];
      return `Line ${first?.line ?? "?"} is neither a setting (NAME=value) nor a comment (# …).`;
    }
    case "json": {
      let value: unknown;
      try {
        value = JSON.parse(text);
      } catch (error) {
        return `This is not valid JSON: ${(error as Error).message}`;
      }
      if (!isPlainObject(value)) {
        return "SOPS needs a JSON object ({ … }) at the top level.";
      }
      return null;
    }
    case "yaml": {
      const documents = parseAllDocuments(text);
      const list = Array.isArray(documents) ? documents : [documents];
      for (const document of list) {
        const error = document.errors[0];
        if (error !== undefined) return `This is not valid YAML: ${error.message}`;
        const value: unknown = document.toJS();
        if (value !== null && value !== undefined && !isPlainObject(value)) {
          return "SOPS needs a mapping (name: value) at the top level of each YAML document.";
        }
      }
      return null;
    }
    case "ini":
    case "text":
      return null;
  }
}

/**
 * Whether the saved file holds what the user wrote, allowing for the
 * reformatting sops does.
 */
export function sameContent(
  format: FileFormat,
  written: string,
  decrypted: string,
): boolean {
  switch (format) {
    case "dotenv":
      return normalizeDotenv(written) === normalizeDotenv(decrypted);
    case "json":
      try {
        return isDeepStrictEqual(JSON.parse(written), JSON.parse(decrypted));
      } catch {
        return false;
      }
    case "yaml":
      try {
        return isDeepStrictEqual(yamlData(written), yamlData(decrypted));
      } catch {
        return false;
      }
    case "ini":
      return normalizeIni(written) === normalizeIni(decrypted);
    case "text":
      return written === decrypted;
  }
}

function isPlainObject(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Every YAML document's data, so multi-document files compare too. */
function yamlData(text: string): unknown[] {
  const documents = parseAllDocuments(text);
  const list = Array.isArray(documents) ? documents : [documents];
  if (list.length <= 1) return [parseYaml(text) ?? null];
  return list.map((document) => document.toJS() ?? null);
}

function normalizeIni(text: string): string {
  return text
    .split("\n")
    .map((line) => line.trim().replace(/\s*=\s*/, "="))
    .filter((line) => line !== "")
    .join("\n");
}
