// shared/channels.ts — realtime channel names shared by server and browser.
// Kept apart from contract.ts so the browser bundle can import a value here
// without pulling in the server-side SDK runtime.

/** Published (with no secret in it) after every save, so lists refresh. */
export const FILES_CHANGED = "files-changed";
