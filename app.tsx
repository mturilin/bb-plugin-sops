// bb-plugin-sops — browser entry: where the plugin appears in BB.
//
// What: registers an "Encrypted files" action in a thread's side panel,
// whose tabs show either the list of encrypted files or one file's editor,
// and a file opener so clicking an encrypted `.env` file anywhere in BB
// opens the editor.
//
// Why: secrets live next to the work, so the editor lives next to the
// thread rather than on a separate page.
//
// Design notes:
// - One panel action serves both screens: without parameters it lists
//   files; with `{ ref }` it edits that file. Tab parameters are saved and
//   come back after a reload, so they are checked here before use, and the
//   server checks the reference again.
// - The file opener matches by last extension only (BB's rule), so it is
//   registered for `env`. For a file that turns out not to be encrypted it
//   shows BB's own preview. YAML and JSON are left to BB's
//   preview, since nearly all of those files are not secrets; encrypted
//   ones open from the list.

import { useEffect, useState } from "react";
import {
  definePluginApp,
  useRpc,
  type PluginFileOpenerProps,
  type PluginThreadPanelProps,
} from "@get-bb/plugin-sdk/app";
import type { FileRef, rpcContract } from "./shared/contract.ts";
import { asFileRef } from "./shared/refs.ts";
import { Editor } from "./app/Editor.tsx";
import { FileList, PANEL_ACTION_ID } from "./app/FileList.tsx";

/** The file reference in a tab's saved parameters, if it is a valid one. */
function refFromParams(params: unknown): FileRef | null {
  if (typeof params !== "object" || params === null || !("ref" in params)) return null;
  return asFileRef((params as { ref: unknown }).ref);
}

/** A side-panel tab: the file list, or one file's editor. */
function FilesPanel({ threadId, params }: PluginThreadPanelProps) {
  const ref = refFromParams(params);
  return ref === null ? <FileList threadId={threadId} /> : <Editor threadId={threadId} fileRef={ref} />;
}

/** Opens a clicked `.env` file in the editor when sops encrypted it, else in BB's preview. */
function FileOpener({ path, source, Original }: PluginFileOpenerProps) {
  const rpc = useRpc<typeof rpcContract>();
  const [resolved, setResolved] = useState<{ ref: FileRef } | null | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    setResolved(undefined);
    rpc
      .call("resolveFile", {
        source: { kind: source.kind, threadId: source.threadId ?? null },
        path,
      })
      .then(
        (result) => {
          if (!cancelled) setResolved(result === null ? null : { ref: result.ref });
        },
        () => {
          if (!cancelled) setResolved(null);
        },
      );
    return () => {
      cancelled = true;
    };
  }, [rpc, path, source.kind, source.threadId]);

  if (resolved === undefined) return null;
  if (resolved === null) return <Original />;
  return <Editor threadId={source.threadId ?? null} fileRef={resolved.ref} />;
}

export default definePluginApp((app) => {
  app.slots.threadPanelAction({
    id: PANEL_ACTION_ID,
    title: "Encrypted files",
    icon: "Lock",
    layout: "flush",
    component: FilesPanel,
  });
  app.slots.fileOpener({
    id: "editor",
    title: "SOPS editor",
    extensions: ["env"],
    component: FileOpener,
  });
});
