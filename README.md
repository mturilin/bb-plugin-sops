# SOPS — a BB plugin

An editor for SOPS-encrypted files in a BB thread's side panel. See
PLUGIN_OVERVIEW.md for what it does and `skills/sops/SKILL.md` for what
agents are told.

## Develop

```sh
npm install
npm test            # unit tests, plus end-to-end tests against real sops
                    # and age with a throwaway key (mise.toml pins them)
npx tsc -p .        # type check
bb plugin build     # dist/
bb plugin install . # register this folder with BB (once)
bb plugin dev       # rebuild and reload on every save
```

## Layout

- `server.ts` — settings and the RPC handlers; works out the thread's folder.
- `server/sops.ts` — finding, decrypting and saving SOPS files (`sops edit`
  driven by a one-shot editor command; see the header for why).
- `server/check.ts` — syntax checks before encrypting, and the comparison
  after saving.
- `server/files.ts`, `server/run.ts` — file listing and path confinement;
  running programs with input, time limits and no logging.
- `shared/` — the RPC contract, the dotenv reader/writer, format rules.
- `app.tsx`, `app/` — the panel action, file opener, file list, editor
  (table and CodeMirror text views) and the review dialog.

## Safety notes

- File references from the browser are re-checked on the server: a file
  must sit inside the thread's folder or a folder from settings (real
  paths, so symlinks cannot lead out), and must carry sops metadata.

## License

GPL-3.0-only. See LICENSE.
