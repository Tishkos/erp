# The Windows desktop build

The ERP, as a Windows application. Built with **Tauri 2**; the whole shell is
`src-tauri/` and the boot page in `desktop/boot/`.

## What it is, and what it deliberately is not

It is a window onto the running server at `https://erp.qs-groups.com`. It runs
**no part of the ERP**: no Next.js, no Node, no database driver, no copy of the
business logic, no credentials.

That is the design, not a shortcut. The application's security rests on
`src/server/db/client.ts` setting `app.user_id`, `app.branch_code` and
`app.is_super_user` on each transaction, with Postgres row-level security
reading them. A desktop build that carried database credentials could set those
itself — a client could declare itself a super user and the database would
believe it. So the desktop build carries none, and the server stays the only
thing that talks to Postgres.

The audit behind this decision is in the session notes; the short form is that
the application is full-stack Next.js (36 Server Action files, 87 pages, zero
client-side calls to an own API, direct DB access with RLS), so there is no
frontend to separate from a backend. Static export would be a rewrite of the
data layer, auth and export pipeline for no functional gain.

What the shell adds over a browser tab: its own icon, window and installer, a
session that survives a restart, downloads that land somewhere predictable, and
a path to auto-update.

## Prerequisites

| | |
|---|---|
| Rust | stable MSVC toolchain — `winget install Rustlang.Rustup` |
| Build tools | Visual Studio with the C++ workload (already present on the build machine) |
| WebView2 | ships with Windows 10/11; the installer does not bundle it |

## Building

```
npm run desktop:dev      # runs against the server, with devtools
npm run desktop:build    # release .exe + NSIS installer
npm run desktop:icons    # regenerate icons from mainLogo.png
```

Output:

```
src-tauri/target/release/qs-erp-desktop.exe                                   ~12.6 MB
src-tauri/target/release/bundle/nsis/Qimah Al-Safinah ERP_1.0.0_x64-setup.exe  ~3.1 MB
```

## Pointing it somewhere else

```
QS_ERP_URL=http://localhost:3000 npm run desktop:dev
```

Read once in Rust before any web content loads, so no page can redirect the
shell at another host. Baked in at compile time if set during `desktop:build`;
otherwise read from the environment at start-up, which lets support aim an
installed copy at a staging host without a rebuild.

## The pieces

| File | What it does |
|---|---|
| `src-tauri/src/lib.rs` | builds the window, decides the server address |
| `src-tauri/src/download.rs` | where a Print / Export copy lands |
| `desktop/boot/index.html` | the boot page — probes the server, then navigates |
| `src-tauri/capabilities/default.json` | what the boot page may do |

**The boot page** exists so that a laptop away from the network gets a sentence
it can act on instead of WebView2's `ERR_NAME_NOT_RESOLVED`. It probes with a
`no-cors` HEAD — which needs no CORS header on the server and no HTTP client in
the binary — then does a normal top-level navigation. The session cookie
belongs to the server's origin, where the WebView2 profile keeps it.

**Downloads** go to the system Downloads folder under the name the server chose
(the export route sets `Content-Disposition`), with ` (2)` rather than
overwriting. Without this handler, pressing PDF on a document appears to do
nothing and the whole export feature looks broken.

## Two build-machine workarounds, and why they are in the repo

Both are in `src-tauri/.cargo/config.toml` and `Cargo.toml`, commented where
they are set.

`rustc 1.98.1` on this machine dies with `STATUS_STACK_BUFFER_OVERRUN` — a
stack overflow inside the compiler — while optimising `windows`, `windows-sys`,
`rustls`, `tokio-util` and `tauri-utils`. It is the optimiser: the same crates
compile at opt-level 0. So `RUST_MIN_STACK` is set in the cargo config rather
than left to whoever runs the build, and the release profile uses `opt-level =
1`. The shell forwards events to WebView2 and does nothing hot, so there is
nothing for the optimiser to win. The size-squeezing set (`lto`,
`codegen-units = 1`, `opt-level = "s"`, `panic = "abort"`) crashed it hardest
and has been dropped.

## Not done yet

- **Code signing.** The installer is unsigned, so Windows SmartScreen will warn
  on first run. Needs an EV or OV certificate.
- **Auto-update.** The updater plugin is compiled in and `active: false`. It
  needs a signing key pair, `pubkey` in `tauri.conf.json`, and a `latest.json`
  served from the VPS.
- **A menu.** Ctrl+P, Ctrl+R and the zoom hotkeys work through WebView2; there
  is no application menu yet.
- **Offline working.** The shell does not provide it and cannot: the ledger is
  on the server. That would be local data and sync — a different project.
