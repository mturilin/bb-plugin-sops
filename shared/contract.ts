// shared/contract.ts — the calls between the editor in the browser and the
// plugin server, checked on both sides of the wire.
//
// What: the shapes of file references, file listings, decrypted files and
// save results, and the RPC contract built from them.
//
// Why: a file reference travels through the browser and is saved with the
// panel tab, so the server must treat it as untrusted. Keeping the shapes
// here, in one schema, means a malformed one is refused before any handler
// runs.
//
// Design notes:
// - A reference never carries an absolute path the server would trust. It
//   is a folder plus a path inside it, and the server only accepts folders
//   it would list itself (the thread's folder or one named in settings).
// - Decrypted text crosses the wire only in `open`'s reply and `save`'s
//   input. Nothing else carries a secret value.

import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

/** A SOPS-encrypted file: a folder the server lists, and a path inside it. */
export const fileRefSchema = z
  .object({
    root: z.string().min(1).max(4096),
    path: z.string().min(1).max(4096),
  })
  .strict();
export type FileRef = z.infer<typeof fileRefSchema>;

const formatSchema = z.enum(["dotenv", "yaml", "json", "ini", "text"]);

/** A SOPS file as listed, read without decrypting it. */
const sopsFileSchema = z.object({
  ref: fileRefSchema,
  format: formatSchema,
  /** The age keys it is encrypted to, as written in the file. */
  recipients: z.array(z.string()),
  /** Whether it is also encrypted to something other than age (PGP, KMS…). */
  otherKeys: z.boolean(),
  /** Number of settings, for dotenv files (names are not encrypted). */
  settingCount: z.number().nullable(),
});
export type SopsFileInfo = z.infer<typeof sopsFileSchema>;

/** A folder searched for SOPS files: its files, or why it could not be. */
const sopsFolderSchema = z.object({
  root: z.string().nullable(),
  /** Where the folder came from: the thread, or the plugin's settings. */
  origin: z.enum(["thread", "settings"]),
  files: z.array(sopsFileSchema),
  /** Set when the folder could not be searched, in plain words. */
  message: z.string().nullable(),
  /** True when the search stopped early because the folder is very large. */
  truncated: z.boolean(),
});
export type SopsFolder = z.infer<typeof sopsFolderSchema>;

export const scanResultSchema = z.object({ folders: z.array(sopsFolderSchema) });
export type ScanResult = z.infer<typeof scanResultSchema>;

/** A decrypted file, ready to edit. */
const openResultSchema = z.object({
  ref: fileRefSchema,
  /** Short name for the tab and header. */
  title: z.string(),
  /** The file's location, home-relative where possible. */
  location: z.string(),
  format: formatSchema,
  content: z.string(),
  /** SHA-256 of the encrypted file as read; saving is refused if it moved. */
  sha256: z.string(),
  recipients: z.array(z.string()),
});
export type OpenResult = z.infer<typeof openResultSchema>;

const saveResultSchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("saved"),
    sha256: z.string(),
    /** The text as it now decrypts (sops may reformat YAML and JSON). */
    content: z.string(),
  }),
  z.object({ outcome: z.literal("unchanged"), sha256: z.string() }),
  z.object({ outcome: z.literal("conflict") }),
]);
export type SaveResult = z.infer<typeof saveResultSchema>;

/** Where a file the user clicked lives, as the file opener reports it. */
const openerSourceSchema = z.object({
  kind: z.enum(["workspace", "host", "thread-storage"]),
  threadId: z.string().nullable(),
});

export const rpcContract = defineRpcContract({
  scan: {
    input: z.object({ threadId: z.string().min(1) }).strict(),
    output: scanResultSchema,
  },
  open: {
    input: z
      .object({ threadId: z.string().nullable(), ref: fileRefSchema })
      .strict(),
    output: openResultSchema,
  },
  save: {
    input: z
      .object({
        threadId: z.string().nullable(),
        ref: fileRefSchema,
        // sops handles far larger files, but an editor tab does not; this
        // keeps one call well inside the RPC size limit.
        content: z.string().max(4_000_000),
        expectedSha256: z.string().regex(/^[0-9a-f]{64}$/),
      })
      .strict(),
    output: saveResultSchema,
  },
  resolveFile: {
    input: z
      .object({ source: openerSourceSchema, path: z.string().min(1).max(4096) })
      .strict(),
    output: z.object({ ref: fileRefSchema, title: z.string() }).nullable(),
  },
});
