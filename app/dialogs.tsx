// app/dialogs.tsx — the review before saving.
//
// What: `ReviewDialog` lists what a save will change (by setting name for
// dotenv, as a diff otherwise) and waits for "Encrypt and save".
//
// Why: the file is written as ciphertext the user cannot read back at a
// glance, so the change is shown before it is made.
//
// Design notes:
// - Values and diffs are hidden (blurred) until "Show values" is pressed:
//   this dialog is where secrets would otherwise end up on screen all at
//   once.

import { useEffect, useState, type ReactNode } from "react";
import { experimental_Diff as Diff } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { diffDotenv, parseDotenv } from "../shared/dotenv.ts";
import type { FileFormat } from "../shared/formats.ts";
import { patchFor } from "./patch.ts";

/** A switch-like button for showing hidden values. */
function RevealButton({ shown, onToggle }: { shown: boolean; onToggle: () => void }) {
  return (
    <Button size="sm" variant="ghost" onClick={onToggle} aria-pressed={shown}>
      <Icon name={shown ? "EyeOff" : "Eye"} />
      {shown ? "Hide values" : "Show values"}
    </Button>
  );
}

/** Content that stays blurred, and unselectable, until revealed. */
function Hidden({ shown, children }: { shown: boolean; children: ReactNode }) {
  return (
    <div
      className={cn("transition-[filter]", !shown && "pointer-events-none select-none blur-[6px]")}
      aria-hidden={!shown}
    >
      {children}
    </div>
  );
}

const MASK = "••••••••";

export interface ReviewDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  format: FileFormat;
  before: string;
  after: string;
  saving: boolean;
  onConfirm: () => void;
}

/** What a save will change, for the user to confirm. */
export function ReviewDialog(props: ReviewDialogProps) {
  const { open, onOpenChange, title, format, before, after, saving, onConfirm } = props;
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!open) setShown(false);
  }, [open]);

  let body: ReactNode;
  if (format === "dotenv") {
    const changes = diffDotenv(before, after);
    // Comments hold no secrets, so a change to them is only mentioned.
    const commentsOf = (text: string) => {
      const parsed = parseDotenv(text);
      if (!parsed.ok) return "";
      return parsed.rows.flatMap((row) => (row.kind === "comment" ? [row.text] : [])).join("\n");
    };
    const commentsChanged = commentsOf(before) !== commentsOf(after);
    const orderOnly = changes.length === 0 && !commentsChanged;
    body = (
      <div className="flex flex-col gap-1.5">
        {changes.map((change) => (
          <div
            key={`${change.kind}-${change.name}`}
            className="flex items-start gap-2 rounded-md border border-border px-3 py-2 text-sm"
          >
            <span
              className="mt-0.5 w-16 shrink-0 text-xs font-medium uppercase tracking-wide"
              style={{
                color:
                  change.kind === "added"
                    ? "var(--success)"
                    : change.kind === "removed"
                      ? "var(--destructive)"
                      : "var(--warning)",
              }}
            >
              {change.kind}
            </span>
            <div className="min-w-0 flex-1">
              <div className="truncate font-mono font-medium">{change.name}</div>
              <div className="mt-0.5 break-all font-mono text-xs text-muted-foreground">
                {change.kind === "changed" ? (
                  <>
                    {shown ? change.before : MASK} <span aria-hidden>→</span>{" "}
                    <span className="text-foreground">{shown ? change.after : MASK}</span>
                  </>
                ) : shown ? (
                  change.value
                ) : (
                  MASK
                )}
              </div>
            </div>
          </div>
        ))}
        {commentsChanged ? (
          <p className="text-xs text-muted-foreground">Comments changed too.</p>
        ) : null}
        {orderOnly ? (
          <p className="text-sm text-muted-foreground">
            Only the order or spacing of lines changed.
          </p>
        ) : null}
      </div>
    );
  } else {
    body = (
      <Hidden shown={shown}>
        <div className="overflow-hidden rounded-md border border-border">
          <Diff patch={patchFor(title, before, after)} path={title} overflow="wrap" />
        </div>
      </Hidden>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Encrypt and save {title}?</DialogTitle>
          <DialogDescription>
            These changes will be encrypted and written to the file. Values are hidden until you
            show them.
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[55vh] overflow-y-auto">{body}</div>
        <DialogFooter className="items-center gap-2 sm:justify-between">
          <RevealButton shown={shown} onToggle={() => setShown((value) => !value)} />
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
              Keep editing
            </Button>
            <Button onClick={onConfirm} disabled={saving}>
              <Icon name="Lock" />
              {saving ? "Encrypting…" : "Encrypt and save"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** An error's message, for showing. */
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
