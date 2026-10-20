// app/CodeEditor.tsx — the text view: a CodeMirror editor themed with BB's
// colours.
//
// What: an editable, syntax-highlighted text area for decrypted files
// (dotenv, YAML, JSON, INI, plain text), with search, undo and
// Ctrl/Cmd+S to save.
//
// Why: BB's own code component only displays code; it cannot be typed in.
// CodeMirror is small, needs no web workers, and its colours can be taken
// from BB's theme variables so it follows light, dark and custom palettes.
//
// Design notes:
// - The editor is created once per mount and kept in a ref. A new `value`
//   from outside (after a save or reload) replaces the document only when it
//   differs from what the editor already holds, so typing never makes the
//   cursor jump.
// - Colours are BB's CSS variables (`--primary`, `--success`, …), never
//   fixed colours, as BB asks of plugins.
// - Line wrapping is on: secrets (keys, tokens) are often single very long
//   lines.

import { useEffect, useRef } from "react";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import {
  HighlightStyle,
  StreamLanguage,
  bracketMatching,
  syntaxHighlighting,
} from "@codemirror/language";
import { json } from "@codemirror/legacy-modes/mode/javascript";
import { properties } from "@codemirror/legacy-modes/mode/properties";
import { yaml } from "@codemirror/legacy-modes/mode/yaml";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { EditorState, type Extension } from "@codemirror/state";
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  placeholder,
} from "@codemirror/view";
import { tags } from "@lezer/highlight";
import type { FileFormat } from "../shared/formats.ts";

/** CodeMirror language support for a file format. */
function languageFor(format: FileFormat): Extension {
  switch (format) {
    case "json":
      return StreamLanguage.define(json);
    case "yaml":
      return StreamLanguage.define(yaml);
    case "dotenv":
    case "ini":
      return StreamLanguage.define(properties);
    case "text":
      return [];
  }
}

const highlight = HighlightStyle.define([
  { tag: [tags.keyword, tags.propertyName, tags.definition(tags.propertyName)], color: "var(--primary)" },
  { tag: [tags.string, tags.special(tags.string)], color: "var(--success)" },
  { tag: [tags.number, tags.bool, tags.null, tags.atom], color: "var(--warning)" },
  { tag: [tags.comment, tags.lineComment, tags.blockComment], color: "var(--muted-foreground)", fontStyle: "italic" },
  { tag: [tags.heading, tags.meta, tags.labelName], color: "var(--primary)", fontWeight: "600" },
  { tag: [tags.operator, tags.punctuation, tags.separator], color: "var(--muted-foreground)" },
  { tag: tags.invalid, color: "var(--destructive)" },
]);

const theme = EditorView.theme({
  "&": {
    height: "100%",
    fontSize: "13px",
    color: "var(--foreground)",
    backgroundColor: "transparent",
  },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "var(--font-mono)", lineHeight: "1.6" },
  ".cm-content": { caretColor: "var(--foreground)", padding: "8px 0" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--foreground)" },
  ".cm-gutters": {
    backgroundColor: "transparent",
    color: "var(--muted-foreground)",
    border: "none",
    paddingLeft: "4px",
  },
  ".cm-activeLine": { backgroundColor: "color-mix(in oklab, var(--accent) 45%, transparent)" },
  ".cm-activeLineGutter": {
    backgroundColor: "transparent",
    color: "var(--foreground)",
  },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
    backgroundColor: "color-mix(in oklab, var(--primary) 28%, transparent) !important",
  },
  ".cm-selectionMatch": { backgroundColor: "color-mix(in oklab, var(--primary) 14%, transparent)" },
  ".cm-searchMatch": { backgroundColor: "color-mix(in oklab, var(--warning) 30%, transparent)" },
  ".cm-searchMatch.cm-searchMatch-selected": {
    backgroundColor: "color-mix(in oklab, var(--warning) 55%, transparent)",
  },
  ".cm-matchingBracket": { backgroundColor: "color-mix(in oklab, var(--primary) 20%, transparent)" },
  ".cm-placeholder": { color: "var(--muted-foreground)" },
  ".cm-panels": {
    backgroundColor: "var(--card)",
    color: "var(--foreground)",
    borderColor: "var(--border)",
  },
  ".cm-panels.cm-panels-top": { borderBottom: "1px solid var(--border)" },
  ".cm-panel.cm-search": { padding: "6px 8px", fontSize: "12px" },
  ".cm-panel.cm-search input, .cm-panel.cm-search button": {
    fontSize: "12px",
    borderRadius: "6px",
    border: "1px solid var(--border)",
    backgroundColor: "transparent",
    color: "var(--foreground)",
    backgroundImage: "none",
  },
  ".cm-panel.cm-search label": { fontSize: "12px" },
});

export interface CodeEditorProps {
  value: string;
  format: FileFormat;
  onChange: (value: string) => void;
  /** Called on Ctrl/Cmd+S inside the editor. */
  onSave: () => void;
}

/**
 * The CodeMirror editor.
 *
 * Side effects: mounts an editor into its own div and destroys it on unmount.
 */
export function CodeEditor({ value, format, onChange, onSave }: CodeEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  // Callbacks change every render; the editor reads them through refs so it
  // never has to be rebuilt.
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);
  onChangeRef.current = onChange;
  onSaveRef.current = onSave;

  useEffect(() => {
    if (host.current === null) return;
    const editor = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          highlightActiveLine(),
          history(),
          drawSelection(),
          bracketMatching(),
          search({ top: true }),
          highlightSelectionMatches(),
          EditorView.lineWrapping,
          placeholder("Empty file"),
          keymap.of([
            {
              key: "Mod-s",
              preventDefault: true,
              run: () => {
                onSaveRef.current();
                return true;
              },
            },
            indentWithTab,
            ...defaultKeymap,
            ...historyKeymap,
            ...searchKeymap,
          ]),
          languageFor(format),
          syntaxHighlighting(highlight),
          theme,
          EditorView.contentAttributes.of({
            // Keep secrets out of spellcheck services and autofill.
            spellcheck: "false",
            autocorrect: "off",
            autocapitalize: "off",
            "data-1p-ignore": "true",
            "data-lpignore": "true",
          }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) onChangeRef.current(update.state.doc.toString());
          }),
        ],
      }),
    });
    view.current = editor;
    return () => {
      editor.destroy();
      view.current = null;
    };
    // The editor is built once per format; value changes are applied below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [format]);

  useEffect(() => {
    const editor = view.current;
    if (editor === null) return;
    const current = editor.state.doc.toString();
    if (current !== value) {
      editor.dispatch({ changes: { from: 0, to: current.length, insert: value } });
    }
  }, [value]);

  return <div ref={host} className="h-full min-h-0 overflow-hidden" />;
}
