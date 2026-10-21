# Changelog

## 0.1.2

- Added Russian interface language alongside the default English interface.
- Switch instantly in Settings → General → Language, or Settings → Language on
  a tablet. Each device remembers its choice without changing board content,
  prompts, model identifiers, or other participants' preferences.
- Failed board imports retry temporary Windows file locks during rollback.
- Updated the Vite 6 build tool to its compatible security patch.

## 0.1.1 — release candidate

This release candidate refreshes the local edition release guidance for the
Windows package and aligns the Assistant documentation with its resizable panel
UI.

## 0.1.0 — release candidate

This release candidate collects the local CanAI studio, including:

- an infinite Canvas for image, video, audio, and text work;
- asynchronous Tasks with recovery after restart;
- Assistant conversations with references and prompt actions;
- Workflow/Macro editing and macro runs from Canvas;
- external image editing through the configured F2 editor;
- tablet access on the local network;
- portable Windows x64 and macOS Apple Silicon launchers.

The release candidate has no claimed release date. Platform verification and
distribution artifacts are recorded by the release workflow when a maintainer
runs it for a specific commit.

Release hardening includes:

- public source exports omit the private developer updater;
- tablet sign-out revokes its session, and turning access off revokes all devices;
- validated backup recovery preserves damaged files, protects media, and holds uncertain paid jobs for review;
- desktop and LAN tablet galleries show when recovered data needs review;
- release preparation can recover from finalization failures without replacing sealed archives;
- completed audio tasks return after reopening a board, including archived results.
