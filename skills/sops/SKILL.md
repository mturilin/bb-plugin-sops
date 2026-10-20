---
name: sops
description: Use when the user wants to see, change, add or rotate a secret kept in a SOPS-encrypted file (`*.sops.env`, `*.sops.yaml`, any file sops encrypted) and the SOPS plugin is installed in BB.
---

# Encrypted files (SOPS plugin)

The SOPS plugin gives the user an editor for SOPS-encrypted files beside
the thread. It decrypts on the machine BB runs on, shows values hidden
until asked, and saves through `sops edit`, so the file keeps its keys and
only changed values get new ciphertext.

## Hand the file to the user rather than decrypting it here

Anything printed in this conversation is stored in the transcript. When a
secret needs changing, open the file in the user's editor instead of
running `sops -d` or `sops edit` yourself:

```sh
bb thread open stacks/abs/secrets.sops.env     # a path relative to the thread's folder
```

That works for `.env` files. For an encrypted YAML, JSON or INI file, tell
the user to open **Encrypted files** from the thread's side-panel menu (the
+ in the right panel) and pick the file there.

Then say what to change (which setting, in which file) without writing the
secret value into the conversation.

## What the user sees

- **Encrypted files** in the side panel: every SOPS file in the thread's
  folder (and in folders listed in the plugin's settings), with its format,
  number of settings and the age keys it is encrypted to.
- The editor: a table of settings for `.env` files, a text editor for every
  format, and a review of the changes before encrypting.

## Limits

- Only folders on the machine BB runs on. A thread whose checkout is on
  another machine gets a message instead of a list.
- sops runs through mise in the file's folder when mise is installed, so
  a repo's pinned sops and its `SOPS_AGE_KEY_FILE` apply. A repo without
  them needs sops on PATH and a key sops can find.
- It edits existing SOPS files; it does not create or encrypt new ones.
- A file that decrypts to binary data is refused.

## Settings

`bb plugin config sops` shows them:

- `extraFolders` — more folders to list SOPS files from, one per line.
- `useMise` — run sops through mise (default on).
- `sopsPath`, `misePath` — program paths, when they are not found on
  their own.
