// bb-plugin-sops — server entry: the plugin's settings and the calls the
// editor makes.
//
// What: lists the SOPS files in a thread's folder (and any folders named in
// settings), and opens and saves them. The work itself is in
// server/sops.ts.
//
// Why: the browser cannot run sops. Everything that touches a key or a file
// happens here, on the machine BB runs on, and each call re-checks the file
// reference it is given.
//
// Design notes:
// - Only folders on the machine BB itself runs on are read. A thread whose
//   checkout is on another machine gets a plain message instead.
// - Settings are re-read on every call, so a change applies without a
//   reload.
// - Nothing here logs file contents or values; logs carry only what failed.

import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { FILES_CHANGED } from "./shared/channels.ts";
import { rpcContract, type SopsFolder } from "./shared/contract.ts";
import { insideFolder, tildePath } from "./server/files.ts";
import {
  decryptSops,
  isSopsContent,
  resolveSopsRef,
  saveSops,
  scanSopsFolder,
  type SopsPrograms,
} from "./server/sops.ts";

export { rpcContract };

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    extraFolders: {
      type: "string",
      label: "Also list SOPS files from these folders (one per line; ~ allowed)",
      experimental_multiline: true,
      default: "",
    },
    useMise: {
      type: "boolean",
      label: "Run sops through mise (uses each repo's pinned sops and key settings)",
      default: true,
    },
    sopsPath: { type: "string", label: "sops program (leave empty to find it)", default: "" },
    misePath: { type: "string", label: "mise program (leave empty to find it)", default: "" },
  });

  const home = homedir();

  async function programs(): Promise<SopsPrograms> {
    const values = await settings.get();
    return { sops: values.sopsPath, mise: values.misePath, useMise: values.useMise };
  }

  /** The folders named in settings, absolute; `~` expanded. */
  async function settingsFolders(): Promise<string[]> {
    const { extraFolders } = await settings.get();
    const folders: string[] = [];
    for (const line of extraFolders.split("\n")) {
      const trimmed = line.trim();
      if (trimmed === "" || trimmed.startsWith("#")) continue;
      const expanded =
        trimmed === "~" ? home : trimmed.startsWith("~/") ? join(home, trimmed.slice(2)) : trimmed;
      if (!isAbsolute(expanded)) continue;
      folders.push(resolve(expanded));
    }
    return [...new Set(folders)];
  }

  /**
   * The folder a thread works in on this machine: its own checkout (which
   * may be a worktree), else its project's default folder.
   *
   * @returns The absolute path, or a plain reason there is none.
   */
  async function threadFolder(threadId: string): Promise<{ path: string } | { message: string }> {
    const { primaryHostId } = await bb.sdk.system.config();
    const thread = await bb.sdk.threads.get({ threadId });
    if (thread.environmentId !== null) {
      const environment = await bb.sdk.environments.get({
        environmentId: thread.environmentId,
      });
      if (environment.hostId !== primaryHostId) {
        return {
          message:
            "This thread works on another machine. This plugin can only read folders on the machine BB runs on.",
        };
      }
      if (environment.path !== null) return { path: environment.path };
    }
    if (thread.projectId === null) return { message: "This thread has no folder." };
    const project = await bb.sdk.projects.get({ projectId: thread.projectId });
    const local = project.sources.filter((source) => source.hostId === primaryHostId);
    const source = local.find((candidate) => candidate.isDefault) ?? local[0];
    if (source === undefined) {
      return { message: "This thread's project has no folder on the machine BB runs on." };
    }
    return { path: source.path };
  }

  /** Every folder a file reference may point into, for this thread. */
  async function allowedRoots(threadId: string | null): Promise<string[]> {
    const roots = await settingsFolders();
    if (threadId !== null) {
      const folder = await threadFolder(threadId).catch(() => null);
      if (folder !== null && "path" in folder) roots.unshift(folder.path);
    }
    return roots;
  }

  async function scanFolder(root: string, origin: SopsFolder["origin"]): Promise<SopsFolder> {
    const failed = (message: string): SopsFolder => ({
      root,
      origin,
      files: [],
      message,
      truncated: false,
    });
    try {
      if (!(await stat(root)).isDirectory()) throw new Error();
    } catch {
      return failed(`The folder ${tildePath(root, home)} does not exist.`);
    }
    try {
      const { files, truncated } = await scanSopsFolder(root);
      return { root, origin, files, message: null, truncated };
    } catch (error) {
      bb.log.warn(`folder scan failed: ${(error as Error).message}`);
      return failed(`Could not search ${tildePath(root, home)}.`);
    }
  }

  bb.rpc.register(rpcContract, {
    scan: async ({ threadId }) => {
      const folders: SopsFolder[] = [];
      const own = await threadFolder(threadId).catch((error: Error) => ({
        message: error.message,
      }));
      if ("path" in own) folders.push(await scanFolder(own.path, "thread"));
      else {
        folders.push({ root: null, origin: "thread", files: [], message: own.message, truncated: false });
      }
      for (const root of await settingsFolders()) {
        if ("path" in own && own.path === root) continue;
        folders.push(await scanFolder(root, "settings"));
      }
      return { folders };
    },

    open: async ({ threadId, ref }) => {
      const file = await resolveSopsRef(ref, await allowedRoots(threadId));
      const decrypted = await decryptSops(await programs(), file);
      return {
        ref,
        title: ref.path.split("/").at(-1) ?? ref.path,
        location: tildePath(file, home),
        format: decrypted.format,
        content: decrypted.content,
        sha256: decrypted.sha256,
        recipients: decrypted.recipients,
      };
    },

    save: async ({ threadId, ref, content, expectedSha256 }) => {
      const file = await resolveSopsRef(ref, await allowedRoots(threadId));
      const result = await saveSops(await programs(), file, content, expectedSha256);
      if (result.outcome === "saved") bb.realtime.publish(FILES_CHANGED, {});
      return result;
    },

    resolveFile: async ({ source, path }) => {
      if (source.kind === "thread-storage") return null;
      let absolute: string;
      if (source.kind === "workspace") {
        if (source.threadId === null) return null;
        const folder = await threadFolder(source.threadId).catch(() => null);
        if (folder === null || !("path" in folder)) return null;
        absolute = join(folder.path, path);
      } else {
        if (!isAbsolute(path)) return null;
        absolute = path;
      }
      for (const root of await allowedRoots(source.threadId)) {
        if (!absolute.startsWith(root + "/")) continue;
        const rel = absolute.slice(root.length + 1);
        const file = await insideFolder(root, rel);
        if (file === null) return null;
        try {
          const text = await readFile(file, "utf8");
          if (!isSopsContent(text)) return null;
          return { ref: { root, path: rel }, title: rel.split("/").at(-1) ?? rel };
        } catch {
          return null;
        }
      }
      return null;
    },
  });
}
