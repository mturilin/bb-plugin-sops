// app/patch.ts — unified patches for BB's diff viewer.
//
// BB's diff component takes a unified patch for one file, so the review
// before saving builds one from the old and new text.

import { createTwoFilesPatch } from "diff";

/** A unified patch from the saved text to the edited text of one file. */
export function patchFor(path: string, before: string, after: string): string {
  return createTwoFilesPatch(path, path, before, after, "", "", { context: 3 });
}
