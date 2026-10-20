// app/FileList.tsx — the list of encrypted files a thread can edit.
//
// What: shows the SOPS files in the thread's folder (and folders named in
// settings), each with what can be known without decrypting it, and opens
// the editor in a new panel tab.
//
// Why: the plugin's entry point. It answers "which secrets files are
// there?" at a glance, without decrypting anything.
//
// Design notes:
// - Each editor opens in its own panel tab (same action, different
//   parameters), so several files can be open side by side; opening a file
//   that is already open focuses its tab.
// - The list refreshes when any save publishes the files-changed signal.

import { useCallback, useEffect, useState } from "react";
import { useBbNavigate, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn, formatHomePathForDisplay } from "@/lib/utils";
import { FILES_CHANGED } from "../shared/channels.ts";
import type {
  FileRef,
  ScanResult,
  SopsFileInfo,
  SopsFolder,
  rpcContract,
} from "../shared/contract.ts";
import { errorText } from "./dialogs.tsx";

/** The panel action that hosts both the list and the editors. */
export const PANEL_ACTION_ID = "files";

const FORMAT_LABEL: Record<SopsFileInfo["format"], string> = {
  dotenv: ".env",
  yaml: "YAML",
  json: "JSON",
  ini: "INI",
  text: "Text",
};

function shortKey(key: string): string {
  return key.length > 16 ? `${key.slice(0, 8)}…${key.slice(-4)}` : key;
}

/** The list. Side effects: RPC scan on mount and on refresh. */
export function FileList({ threadId }: { threadId: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [scan, setScan] = useState<ScanResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState("");

  const refresh = useCallback(() => {
    setLoading(true);
    rpc.call("scan", { threadId }).then(
      (result) => {
        setScan(result);
        setError(null);
        setLoading(false);
      },
      (cause: unknown) => {
        setError(errorText(cause));
        setLoading(false);
      },
    );
  }, [rpc, threadId]);
  useEffect(refresh, [refresh]);
  useRealtime(FILES_CHANGED, refresh);

  const openEditor = (ref: FileRef, title: string) => {
    navigate.openThreadPanel({ actionId: PANEL_ACTION_ID, title, params: { ref } });
  };

  const needle = filter.trim().toLowerCase();
  const matches = (text: string) => needle === "" || text.toLowerCase().includes(needle);
  const total = scan?.folders.reduce((n, folder) => n + folder.files.length, 0) ?? 0;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2.5">
        <Icon name="Lock" className="size-4 text-muted-foreground" />
        <h2 className="flex-1 text-sm font-semibold">Encrypted files</h2>
        <Button
          size="icon"
          variant="ghost"
          className="size-7"
          onClick={refresh}
          disabled={loading}
          aria-label="Search again"
        >
          <Icon name="RotateCcw" className={cn("size-3.5", loading && "animate-spin")} />
        </Button>
      </div>
      {total > 8 ? (
        <div className="border-b border-border px-3 py-2">
          <input
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Filter files"
            aria-label="Filter files"
            className="h-8 w-full rounded-md border border-border bg-transparent px-2 text-sm outline-none placeholder:text-muted-foreground focus:border-ring"
          />
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {error !== null ? (
          <p role="alert" className="px-2 py-3 text-sm text-destructive">
            {error}
          </p>
        ) : scan === null ? (
          <p className="px-2 py-3 text-sm text-muted-foreground">Looking for encrypted files…</p>
        ) : (
          <div className="flex flex-col gap-4">
            {scan.folders.map((folder) => (
              <FolderSection
                key={`${folder.origin}:${folder.root ?? ""}`}
                folder={folder}
                files={folder.files.filter((file) => matches(file.ref.path))}
                onOpen={openEditor}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * A section's label and its folder. Only the folder's own name is shown
 * (the full path is in the tooltip): enough to tell folders apart, and a
 * screenshot of the list does not carry the user's home path.
 */
function SectionHeader({ title, folder }: { title: string; folder: string | null }) {
  const name = folder === null ? null : (folder.split("/").filter((part) => part !== "").at(-1) ?? folder);
  return (
    <div className="flex items-baseline gap-2 px-2 pb-1">
      <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</span>
      {name !== null ? (
        <span className="truncate font-mono text-xs text-muted-foreground" title={folder ?? undefined}>
          {name}
        </span>
      ) : null}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-2 rounded-lg border border-dashed border-border px-3 py-4 text-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}

function FolderSection({
  folder,
  files,
  onOpen,
}: {
  folder: SopsFolder;
  files: SopsFileInfo[];
  onOpen: (ref: FileRef, title: string) => void;
}) {
  return (
    <section>
      <SectionHeader
        title={folder.origin === "thread" ? "This thread's folder" : "Folder"}
        folder={folder.root === null ? null : formatHomePathForDisplay(folder.root)}
      />
      {folder.message !== null ? (
        <Empty>{folder.message}</Empty>
      ) : files.length === 0 ? (
        <Empty>No SOPS-encrypted files here.</Empty>
      ) : (
        <ul className="flex flex-col">
          {files.map((file) => {
            const slash = file.ref.path.lastIndexOf("/");
            const dir = slash === -1 ? "" : file.ref.path.slice(0, slash + 1);
            const name = file.ref.path.slice(slash + 1);
            const facts = [
              FORMAT_LABEL[file.format],
              file.settingCount !== null
                ? `${file.settingCount} setting${file.settingCount === 1 ? "" : "s"}`
                : null,
              file.recipients.length > 0 ? file.recipients.map(shortKey).join(", ") : null,
              file.otherKeys ? "other keys too" : null,
            ].filter((fact) => fact !== null);
            return (
              <FileRow
                key={file.ref.path}
                icon="Lock"
                primary={
                  <>
                    <span className="text-muted-foreground">{dir}</span>
                    <span className="font-medium text-foreground">{name}</span>
                  </>
                }
                secondary={facts.join(" · ")}
                onOpen={() => onOpen(file.ref, name)}
              />
            );
          })}
        </ul>
      )}
      {folder.truncated ? (
        <p className="px-2 pt-1 text-xs text-muted-foreground">
          This folder is very large; only part of it was searched.
        </p>
      ) : null}
    </section>
  );
}

function FileRow({
  icon,
  primary,
  secondary,
  onOpen,
}: {
  icon: string;
  primary: React.ReactNode;
  secondary: string;
  onOpen: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className="group flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-[color-mix(in_oklab,var(--accent)_60%,transparent)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        <Icon name={icon} className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1">
          <span className="block truncate font-mono text-[13px]">{primary}</span>
          <span className="block truncate text-xs text-muted-foreground">{secondary}</span>
        </span>
        <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
          <Icon name="sops/pencil" className="size-3" />
          Edit
        </span>
      </button>
    </li>
  );
}
