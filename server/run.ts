// server/run.ts — running sops, mise and git as child processes.
//
// What: finds each program and runs it with text piped in, its output
// collected, and a time limit.
//
// Why: the BB server starts with a shorter PATH than a login shell, and
// every program here handles secrets: their output must never reach a log,
// and a stuck process (say, one waiting for a key press) must not hang a
// save forever.
//
// Design notes:
// - Programs are looked for on PATH first, then in the usual user install
//   folders (`~/.local/bin`, mise's shims, Homebrew, /usr/bin).
// - `run` never logs arguments, input or output. Error messages built from
//   stderr are trimmed to the first few lines; sops does not print
//   decrypted values on stderr.
// - Processes run without a terminal (stdin is a pipe), so nothing can stop
//   to ask a question; anything that tries fails or hits the time limit.

import { spawn } from "node:child_process";
import { access, constants } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

/** What a finished process left behind. */
export interface RunResult {
  code: number | null;
  /** stdout as UTF-8 text (lossy if it was not text; see stdoutBytes). */
  stdout: string;
  /** stdout exactly as written, for binary output such as age ciphertext. */
  stdoutBytes: Buffer;
  stderr: string;
  /** True when the time limit killed it. */
  timedOut: boolean;
}

/** Options for one run. */
export interface RunOptions {
  cwd: string;
  /** Bytes written to the process's stdin, which is then closed. */
  input?: string | Buffer;
  /** Extra environment variables, over the server's own. */
  env?: Record<string, string>;
  /** Milliseconds before the process is killed (default 30 s). */
  timeoutMs?: number;
  /** Largest stdout kept, in bytes (default 16 MB); more is an error. */
  maxOutputBytes?: number;
}

/**
 * Runs a program and waits for it.
 *
 * Pre-conditions: `command` is an absolute path or a name on PATH.
 * Side effects: starts a child process; kills it (SIGKILL) at the time limit
 * or when its output passes `maxOutputBytes`.
 * @returns Its exit code and output. Never throws for a non-zero exit; throws
 *   only if the program cannot be started.
 */
export function run(
  command: string,
  args: readonly string[],
  options: RunOptions,
): Promise<RunResult> {
  const maxOutput = options.maxOutputBytes ?? 16 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let timedOut = false;
    let overflow = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, options.timeoutMs ?? 30_000);
    child.stdout.on("data", (chunk: Buffer) => {
      outBytes += chunk.length;
      if (outBytes > maxOutput) {
        overflow = true;
        child.kill("SIGKILL");
        return;
      }
      out.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      // stderr is only ever used for short error messages.
      if (err.reduce((n, b) => n + b.length, 0) < 64 * 1024) err.push(chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const bytes = overflow ? Buffer.alloc(0) : Buffer.concat(out);
      resolve({
        code: overflow ? null : code,
        stdout: bytes.toString("utf8"),
        stdoutBytes: bytes,
        stderr: overflow
          ? "The program printed more than this editor can hold."
          : Buffer.concat(err).toString("utf8"),
        timedOut,
      });
    });
    // A process that exits without reading its input closes the pipe early;
    // that is its business, not an error here.
    child.stdin.on("error", () => {});
    child.stdin.end(options.input ?? "");
  });
}

/**
 * The first few meaningful lines of a program's error output, for showing to
 * the user. sops prefixes lines with a log header; that is kept, since it
 * names the problem.
 */
export function briefError(result: RunResult, fallback: string): string {
  if (result.timedOut) return `${fallback} (it took too long and was stopped).`;
  const lines = result.stderr
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  if (lines.length === 0) return fallback;
  return lines.slice(0, 4).join("\n").slice(0, 800);
}

/** Folders tried after PATH, for programs installed per user. */
function extraFolders(): string[] {
  const home = homedir();
  return [
    join(home, ".local", "bin"),
    join(home, ".local", "share", "mise", "shims"),
    join(home, "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
  ];
}

const found = new Map<string, string | null>();

/**
 * The full path of a program, or null when it is not installed.
 *
 * @param name The program's file name, e.g. "sops".
 * @param override A path from the plugin's settings, used as-is when set.
 * Side effects: remembers the answer for the life of this plugin load.
 */
export async function findProgram(
  name: string,
  override = "",
): Promise<string | null> {
  if (override.trim() !== "") return override.trim();
  const cached = found.get(name);
  if (cached !== undefined) return cached;
  const folders = [
    ...(process.env.PATH ?? "").split(delimiter).filter((f) => f !== ""),
    ...extraFolders(),
  ];
  for (const folder of folders) {
    const candidate = join(folder, name);
    try {
      await access(candidate, constants.X_OK);
      found.set(name, candidate);
      return candidate;
    } catch {
      // not here; try the next folder
    }
  }
  found.set(name, null);
  return null;
}
