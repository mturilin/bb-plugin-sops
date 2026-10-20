Edit SOPS-encrypted secrets beside the thread they belong to, without a
terminal and without the plaintext ever touching disk.

## What you get

- **Encrypted files** in every thread's side panel: the SOPS-encrypted
  files in the thread's repo, with their format, number of settings and
  the age keys they are encrypted to — all read without decrypting.
- An editor that decrypts on open: a table for `.env` files (values hidden
  until you ask, copy, or replace with a fresh random secret) and a text
  editor with highlighting for YAML, JSON, INI and plain text.
- A review of your changes before anything is encrypted, with values hidden
  until you show them.
- Clicking an encrypted `.env` file anywhere in BB opens it in the editor.

## How it works

Everything runs on the machine BB runs on, with your own sops, run through
mise in the repo so the repo's pinned version and key settings apply.
Saving goes through `sops edit`, so the file keeps its keys and only the
values you changed get new ciphertext; the result is decrypted again and
compared with what you wrote, and put back if it differs. A save is refused
if the file changed on disk since you opened it.

No account, network service or key of its own. The plugin never writes
plaintext or logs values; sops keeps a private temporary file while it
re-encrypts, as it does in a terminal.
