// shared/formats.ts — what kind of text a SOPS file decrypts to.
//
// What: maps a file name to the editor language (dotenv, YAML, JSON, INI or
// plain text).
//
// Why: the editor picks its view and highlighting from the format, and the
// server checks the text in that format before encrypting. sops decides the
// format from the last extension alone, so this must too, or the editor
// would show one thing and sops would read another.
//
// Design notes:
// - `.env` is dotenv, `.yaml`/`.yml` YAML, `.json` JSON, `.ini` INI;
//   anything else sops stores as one opaque block ("binary"), shown as text.

/** The editor language for a decrypted file. */
export type FileFormat = "dotenv" | "yaml" | "json" | "ini" | "text";

/** The format sops reads a file as, from its name (sops' own rule). */
export function sopsFormatFor(path: string): FileFormat {
  const name = path.split("/").at(-1) ?? path;
  const dot = name.lastIndexOf(".");
  switch (dot <= 0 ? "" : name.slice(dot + 1).toLowerCase()) {
    case "env":
      return "dotenv";
    case "yaml":
    case "yml":
      return "yaml";
    case "json":
      return "json";
    case "ini":
      return "ini";
    default:
      return "text";
  }
}
