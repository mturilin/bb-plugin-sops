// app/EnvTable.tsx — the table view of a dotenv file: one row per setting,
// values hidden until asked for.
//
// What: edit names and values, add and delete settings, edit comments,
// reveal or copy a single value, fill a value with a fresh random secret,
// and filter by name. Problems (empty or repeated names) show under the row.
//
// Why: most edits to a secrets file are "change this one value" or "add a
// setting". A table does that without showing every other secret on the
// screen at once.
//
// Design notes:
// - Hidden values use the CSS `-webkit-text-security: disc` property on an
//   ordinary text input rather than `type="password"`: the field still
//   edits and copies normally, and password managers do not offer to save
//   it.
// - Rows are owned by the editor (app/Editor.tsx); this view only reports
//   the new list on every change.
// - Generated values are 32 random bytes as base64url (43 characters), from
//   the browser's cryptographic generator.

import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { checkRows, newRowId, type DotenvRow } from "../shared/dotenv.ts";

/** A new random secret: 32 bytes, base64url, no padding. */
function randomSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const fieldClass =
  "h-8 w-full min-w-0 rounded-md border border-transparent bg-transparent px-2 font-mono text-[13px] text-foreground outline-none transition-colors placeholder:text-muted-foreground hover:border-border focus:border-ring focus:bg-background";

export interface EnvTableProps {
  rows: DotenvRow[];
  onChange: (rows: DotenvRow[]) => void;
  /** Show every value (the editor's "Show values" switch). */
  revealAll: boolean;
}

/** The table. Side effects: writes to the clipboard when asked to copy. */
export function EnvTable({ rows, onChange, revealAll }: EnvTableProps) {
  const [filter, setFilter] = useState("");
  const [revealed, setRevealed] = useState<Set<string>>(() => new Set());
  const [focusId, setFocusId] = useState<string | null>(null);
  const problems = useMemo(() => checkRows(rows), [rows]);
  const list = useRef<HTMLDivElement>(null);
  // A new row's name field takes focus once it has rendered.
  useEffect(() => {
    if (focusId === null) return;
    list.current?.querySelector<HTMLInputElement>(`[data-name-of="${focusId}"]`)?.focus();
    setFocusId(null);
  }, [focusId, rows]);
  const settingCount = rows.filter((row) => row.kind === "setting").length;

  const update = (id: string, change: Partial<{ name: string; value: string; text: string }>) => {
    onChange(
      rows.map((row) => (row.id === id ? ({ ...row, ...change } as DotenvRow) : row)),
    );
  };
  const remove = (id: string) => onChange(rows.filter((row) => row.id !== id));
  const add = () => {
    const id = newRowId();
    setFilter("");
    setRevealed((previous) => new Set(previous).add(id));
    onChange([...rows, { id, kind: "setting", name: "", value: "" }]);
    setFocusId(id);
  };
  const toggleReveal = (id: string) =>
    setRevealed((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const needle = filter.trim().toLowerCase();
  const visible = needle === ""
    ? rows
    : rows.filter((row) => row.kind === "setting" && row.name.toLowerCase().includes(needle));

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <div className="relative min-w-0 flex-1">
          <Icon
            name="Search"
            className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
          />
          <input
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder={`Filter ${settingCount} setting${settingCount === 1 ? "" : "s"} by name`}
            aria-label="Filter settings by name"
            className="h-8 w-full rounded-md border border-border bg-transparent pl-7 pr-2 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:border-ring"
          />
        </div>
        <Button size="sm" variant="outline" onClick={add}>
          <Icon name="Plus" />
          Add setting
        </Button>
      </div>

      <div ref={list} className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {visible.length === 0 ? (
          <div className="mx-1 mt-2 rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
            {rows.length === 0 ? "No settings yet." : "No setting matches that name."}
          </div>
        ) : (
          <ul className="flex flex-col">
            {visible.map((row) => {
              const problem = problems.get(row.id);
              if (row.kind === "comment") {
                return (
                  <li key={row.id} className="group flex items-center gap-1 rounded-md px-1">
                    <span className="w-4 shrink-0 text-center font-mono text-[13px] text-muted-foreground">#</span>
                    <input
                      value={row.text}
                      onChange={(event) => update(row.id, { text: event.target.value })}
                      aria-label="Comment"
                      spellCheck={false}
                      className={cn(fieldClass, "italic text-muted-foreground")}
                    />
                    <RowButton icon="Trash2" label="Delete comment" onClick={() => remove(row.id)} />
                  </li>
                );
              }
              const shown = revealAll || revealed.has(row.id);
              return (
                <li key={row.id} className="group rounded-md px-1 hover:bg-[color-mix(in_oklab,var(--accent)_35%,transparent)]">
                  <div className="flex items-center gap-1">
                    <span className="flex w-4 shrink-0 justify-center text-muted-foreground">
                      <Icon name="Lock" className="size-3" />
                    </span>
                    <input
                      value={row.name}
                      onChange={(event) => update(row.id, { name: event.target.value })}
                      placeholder="NAME"
                      aria-label="Setting name"
                      spellCheck={false}
                      autoComplete="off"
                      data-name-of={row.id}
                      className={cn(fieldClass, "w-[38%] shrink-0 font-medium")}
                    />
                    <span className="shrink-0 font-mono text-[13px] text-muted-foreground">=</span>
                    <input
                      value={row.value}
                      onChange={(event) => update(row.id, { value: event.target.value })}
                      placeholder="empty"
                      aria-label={`Value of ${row.name || "new setting"}`}
                      spellCheck={false}
                      autoComplete="off"
                      data-1p-ignore="true"
                      data-lpignore="true"
                      style={shown ? undefined : ({ WebkitTextSecurity: "disc" } as React.CSSProperties)}
                      // An empty value shows a dimmed, italic "empty", so it is not
                      // mistaken for a value.
                      className={cn(fieldClass, "flex-1 placeholder:italic placeholder:opacity-60")}
                    />
                    <div className="flex shrink-0 items-center opacity-60 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
                      <RowButton
                        icon={shown ? "EyeOff" : "Eye"}
                        label={shown ? "Hide value" : "Show value"}
                        onClick={() => toggleReveal(row.id)}
                        disabled={revealAll}
                      />
                      <RowButton
                        icon="Copy"
                        label="Copy value"
                        onClick={() => {
                          navigator.clipboard.writeText(row.value).then(
                            () => toast.success(`Copied the value of ${row.name || "the setting"}`),
                            () => toast.error("Could not copy to the clipboard"),
                          );
                        }}
                      />
                      <RowButton
                        icon="sops/dice"
                        label="Replace with a new random secret"
                        onClick={() => {
                          update(row.id, { value: randomSecret() });
                          toast.success(`New random value for ${row.name || "the setting"}`);
                        }}
                      />
                      <RowButton icon="Trash2" label="Delete setting" onClick={() => remove(row.id)} />
                    </div>
                  </div>
                  {problem === undefined ? null : (
                    <p
                      className="pb-1 pl-7 text-xs"
                      style={{ color: problem.severity === "error" ? "var(--destructive)" : "var(--warning)" }}
                    >
                      {problem.message}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

function RowButton({
  icon,
  label,
  onClick,
  disabled = false,
}: {
  icon: string;
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <Button
      variant="ghost"
      size="icon"
      className="size-7 text-muted-foreground hover:text-foreground"
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
    >
      <Icon name={icon} className="size-3.5" />
    </Button>
  );
}
