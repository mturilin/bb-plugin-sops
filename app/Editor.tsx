// app/Editor.tsx — one encrypted file, decrypted for editing.
//
// What: loads a file's plaintext from the server, offers the table view
// (dotenv) and the text view, tracks unsaved changes, and saves through the
// review dialog.
//
// Why: this is the plugin's main screen; everything else leads here.
//
// Design notes:
// - The text is the one source of truth. The table edits rows and writes
//   them back to text on every change; switching to the table re-reads the
//   text, and refuses (staying in text view) while a line would not parse.
// - Plaintext lives only in this component's state. It is not put in the
//   tab's saved parameters, local storage or logs; closing the tab drops it.
// - Values start hidden in both views. The text view is blurred until
//   "Show values"; the table hides each value until asked.
// - A save sends the hash of the encrypted file as it was when opened. If
//   the file changed on disk since, the server refuses and the editor keeps
//   the user's text, offering to copy it or reload.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import type { FileRef, OpenResult, rpcContract } from "../shared/contract.ts";
import {
  checkRows,
  normalizeDotenv,
  parseDotenv,
  serializeDotenv,
  type DotenvRow,
} from "../shared/dotenv.ts";
import { CodeEditor } from "./CodeEditor.tsx";
import { ReviewDialog, errorText } from "./dialogs.tsx";
import { EnvTable } from "./EnvTable.tsx";

type Load =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; file: OpenResult };

/** An age key shortened for display: `age1qyp…k7m2`. */
function shortKey(key: string): string {
  return key.length > 16 ? `${key.slice(0, 8)}…${key.slice(-4)}` : key;
}

const FORMAT_LABEL: Record<OpenResult["format"], string> = {
  dotenv: ".env",
  yaml: "YAML",
  json: "JSON",
  ini: "INI",
  text: "Text",
};

export interface EditorProps {
  threadId: string | null;
  fileRef: FileRef;
}

/** Loads and edits one file. Side effects: RPC calls to open and save it. */
export function Editor({ threadId, fileRef }: EditorProps) {
  const rpc = useRpc<typeof rpcContract>();
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoad({ status: "loading" });
    rpc.call("open", { threadId, ref: fileRef }).then(
      (file) => {
        if (!cancelled) setLoad({ status: "ready", file });
      },
      (error: unknown) => {
        if (!cancelled) setLoad({ status: "error", message: errorText(error) });
      },
    );
    return () => {
      cancelled = true;
    };
    // fileRef is compared by content: the panel rebuilds it from params.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rpc, threadId, JSON.stringify(fileRef), reloadKey]);

  if (load.status === "loading") {
    return (
      <Centered>
        <Icon name="Lock" className="size-5 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">Decrypting…</p>
      </Centered>
    );
  }
  if (load.status === "error") {
    return (
      <Centered>
        <Icon name="AlertTriangle" className="size-5 text-destructive" />
        <p role="alert" className="max-w-md whitespace-pre-wrap text-center text-sm text-destructive">
          {load.message}
        </p>
        <Button size="sm" variant="outline" onClick={() => setReloadKey((key) => key + 1)}>
          Try again
        </Button>
      </Centered>
    );
  }
  return (
    <LoadedEditor
      key={`${load.file.sha256}-${reloadKey}`}
      threadId={threadId}
      file={load.file}
      onReload={() => setReloadKey((key) => key + 1)}
    />
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full min-h-40 flex-col items-center justify-center gap-3 p-6">{children}</div>
  );
}

function LoadedEditor({
  threadId,
  file,
  onReload,
}: {
  threadId: string | null;
  file: OpenResult;
  onReload: () => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const isDotenv = file.format === "dotenv";
  const [baseline, setBaseline] = useState(file.content);
  const [sha, setSha] = useState(file.sha256);
  const [text, setText] = useState(file.content);
  const [view, setView] = useState<"table" | "text">(() =>
    isDotenv && parseDotenv(file.content).ok ? "table" : "text",
  );
  const [rows, setRows] = useState<DotenvRow[]>(() => {
    const parsed = parseDotenv(file.content);
    return parsed.ok ? parsed.rows : [];
  });
  const [reveal, setReveal] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);

  const dirty = isDotenv
    ? normalizeDotenv(text) !== normalizeDotenv(baseline)
    : text !== baseline;

  // What would stop a save, in plain words; null when it can go ahead.
  const blocker = useMemo((): string | null => {
    if (!isDotenv) return null;
    const parsed = parseDotenv(text);
    if (!parsed.ok) {
      const first = parsed.errors[0];
      return `Line ${first?.line ?? "?"} is neither a setting (NAME=value) nor a comment (# …).`;
    }
    for (const problem of checkRows(parsed.rows).values()) {
      if (problem.severity === "error") return problem.message;
    }
    return null;
  }, [isDotenv, text]);

  const settingCount = isDotenv
    ? (() => {
        const parsed = parseDotenv(text);
        return parsed.ok ? parsed.rows.filter((row) => row.kind === "setting").length : null;
      })()
    : null;

  const changeRows = (next: DotenvRow[]) => {
    setRows(next);
    setText(serializeDotenv(next));
  };

  const switchView = (next: "table" | "text") => {
    if (next === view) return;
    if (next === "table") {
      const parsed = parseDotenv(text);
      if (!parsed.ok) {
        toast.error(
          `Line ${parsed.errors[0]?.line ?? "?"} is not a setting or a comment. Fix it here before switching to the table.`,
        );
        return;
      }
      setRows(parsed.rows);
    }
    setView(next);
  };

  const startSave = useCallback(() => {
    if (!dirty || saving) return;
    if (blocker !== null) {
      toast.error(blocker);
      return;
    }
    setReviewing(true);
  }, [dirty, saving, blocker]);

  // Ctrl/Cmd+S anywhere in the editor (the text view handles its own).
  const [editorRoot, setEditorRoot] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        const target = event.target as Node | null;
        if (target !== null && editorRoot?.contains(target)) {
          event.preventDefault();
          startSave();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const save = async () => {
    setSaving(true);
    try {
      const result = await rpc.call("save", {
        threadId,
        ref: file.ref,
        content: text,
        expectedSha256: sha,
      });
      setReviewing(false);
      if (result.outcome === "conflict") {
        setConflict(true);
        return;
      }
      setSha(result.sha256);
      if (result.outcome === "unchanged") {
        setBaseline(text);
        toast.info("Nothing to save: the file already holds this.");
        return;
      }
      setBaseline(result.content);
      setText(result.content);
      const parsed = isDotenv ? parseDotenv(result.content) : null;
      if (parsed?.ok === true) setRows(parsed.rows);
      setConflict(false);
      toast.success(`Encrypted and saved ${file.title}`);
    } catch (error) {
      toast.error(errorText(error));
    } finally {
      setSaving(false);
    }
  };

  const revert = () => {
    setText(baseline);
    const parsed = parseDotenv(baseline);
    if (isDotenv && parsed.ok) setRows(parsed.rows);
  };

  return (
    <div ref={setEditorRoot} className="flex h-full min-h-0 flex-col">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-3 py-2.5">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-[color-mix(in_oklab,var(--primary)_14%,transparent)] text-primary">
            <Icon name="Lock" className="size-3.5" />
          </span>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="truncate text-sm font-semibold">{file.title}</span>
              {dirty ? (
                <span
                  className="size-2 shrink-0 rounded-full"
                  style={{ backgroundColor: "var(--warning)" }}
                  title="Unsaved changes"
                  aria-label="Unsaved changes"
                />
              ) : null}
            </div>
            <div className="truncate text-xs text-muted-foreground" title={file.location}>
              {file.location}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          {isDotenv ? (
            <div className="flex rounded-md border border-border p-0.5" role="group" aria-label="View">
              {(["table", "text"] as const).map((option) => (
                <button
                  key={option}
                  type="button"
                  onClick={() => switchView(option)}
                  aria-pressed={view === option}
                  className={cn(
                    "rounded px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground",
                    view === option && "bg-[color-mix(in_oklab,var(--accent)_80%,transparent)] text-foreground",
                  )}
                >
                  {option === "table" ? "Table" : "Text"}
                </button>
              ))}
            </div>
          ) : null}
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setReveal((value) => !value)}
            aria-pressed={reveal}
            aria-label={reveal ? "Hide values" : "Show values"}
          >
            <Icon name={reveal ? "EyeOff" : "Eye"} />
            {reveal ? "Hide" : "Show"}
          </Button>
          <Button size="sm" variant="ghost" onClick={revert} disabled={!dirty || saving}>
            Revert
          </Button>
          <Button size="sm" onClick={startSave} disabled={!dirty || saving} aria-label="Save (Ctrl+S)">
            <Icon name="Lock" />
            Save
          </Button>
        </div>
      </div>

      {/* Facts line */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-3 py-1.5 text-xs text-muted-foreground">
        <span>{FORMAT_LABEL[file.format]}</span>
        {settingCount !== null ? (
          <span>
            {settingCount} setting{settingCount === 1 ? "" : "s"}
          </span>
        ) : null}
        <span title={file.recipients.join("\n")}>
          {file.recipients.length === 0
            ? "no age keys"
            : `encrypted to ${file.recipients.map(shortKey).join(", ")}`}
        </span>
        {blocker !== null && dirty ? (
          <span style={{ color: "var(--destructive)" }}>{blocker}</span>
        ) : null}
      </div>

      {/* Banners */}
      {conflict ? (
        <Banner tone="destructive" icon="AlertTriangle">
          <span className="flex-1">
            This file changed on disk since you opened it, so it was not saved. Your edits are
            still here.
          </span>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              navigator.clipboard.writeText(text).then(
                () => toast.success("Copied your text"),
                () => toast.error("Could not copy to the clipboard"),
              );
            }}
          >
            Copy my text
          </Button>
          <Button size="sm" variant="outline" onClick={onReload}>
            Reload (drops my edits)
          </Button>
        </Banner>
      ) : null}

      {/* Body */}
      <div className="relative min-h-0 flex-1">
        {view === "table" ? (
          <EnvTable rows={rows} onChange={changeRows} revealAll={reveal} />
        ) : (
          <>
            <div
              className={cn(
                "h-full transition-[filter]",
                !reveal && "pointer-events-none select-none blur-[6px]",
              )}
              aria-hidden={!reveal}
            >
              <CodeEditor value={text} format={file.format} onChange={setText} onSave={startSave} />
            </div>
            {!reveal ? (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-2">
                <p className="text-sm text-muted-foreground">Values are hidden.</p>
                <Button size="sm" variant="outline" onClick={() => setReveal(true)}>
                  <Icon name="Eye" />
                  Show and edit
                </Button>
              </div>
            ) : null}
          </>
        )}
      </div>

      <ReviewDialog
        open={reviewing}
        onOpenChange={(open) => {
          if (!saving) setReviewing(open);
        }}
        title={file.title}
        format={file.format}
        before={baseline}
        after={text}
        saving={saving}
        onConfirm={save}
      />
    </div>
  );
}

function Banner({
  tone,
  icon,
  children,
}: {
  tone: "destructive";
  icon: string;
  children: React.ReactNode;
}) {
  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2 text-sm"
      style={{ backgroundColor: `color-mix(in oklab, var(--${tone}) 10%, transparent)` }}
    >
      <Icon name={icon} className="size-4 shrink-0" style={{ color: `var(--${tone})` }} />
      {children}
    </div>
  );
}
