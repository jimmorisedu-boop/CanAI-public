# Public CanAI contributor notes

This file is the public contributor policy. A clean public export places it at
the repository root as `AGENTS.md`.

## Public snapshot and contribution flow

The maintainer's repository roles are fixed:

| Role | Local checkout | GitHub repository |
| --- | --- | --- |
| Development: features, fixes, and release preparation | `F:\Exp\CanAI` | `jimmorisedu-boop/CanAI` |
| Production: verified source snapshots and release packages | `F:\Exp\CanAI-public` | `jimmorisedu-boop/CanAI-public` |

The production repository contains the generated **local edition**. The word
`public` in its name does not authorize a GitHub visibility change; verify the
actual visibility and require the owner's explicit authorization to change it.
Legacy private history, tags, and release assets must remain in a private archive
and must never be imported into the public repository. Do not rename or
move either repository, merge their histories, or swap their remotes.
Make maintainer changes in development, then run `npm run release:prepare`
there. Only push a clean generated production snapshot whose HEAD matches
the successful release pointer; verify the checkout path and origin first.

The official public tree is generated from the private **CanAI-dev** authoring
checkout. A source ZIP or public snapshot is a reviewable release artifact,
not the authoring repository. Work in a public fork or snapshot is welcome.
Maintainers port accepted changes into **CanAI-dev**, run the checked export,
and publish the result separately. Do not merge private Git history into a
public fork or continue feature work in an old generated export.

Every official snapshot records its version, authoring revision, generated
public revision, checksums, and platform evidence. The public export includes
the local Express backend, local boards, fal.ai generation, and tablet access
to the owner's computer over LAN. CanAI Cloud, shared network boards,
collaboration, accounts, and Cloud bridges are excluded from source and
runtime. Credentials, local data, and runtime state stay out of the export.
Every new source manifest records `edition: local`.
Native platform or CI status is reported only when that check
actually ran.

## Project boundaries

- CanAI is a local browser client and local server for content work on a
  Canvas, plus a tablet client and Workflow/Macro tools.
- This production edition is local-only. Do not add CanAI Cloud connections,
  Cloud accounts, shared network boards, or collaboration transports. Those
  features belong to the separate development edition.
- Keep user content, provider credentials, and local runtime data outside Git.
  Never add `server/.env`, `server/data/`, generated media, or personal logs.

## Working rules

- Read `README.md`, `CONTRIBUTING.md`, and the relevant guide before changing
  a user-visible workflow.
- Preserve API routes, storage keys, IDs, schemas, security checks, and legacy
  compatibility unless the change updates the documented contract.
- English is the default interface; Russian is selected per device in Settings.
  Translate application labels through `client/src/i18n/` and preserve user
  content, model names, API values, and positional placeholders.
- Keep provider calls explicit and testable. `CANAI_MOCK=1` is opt-in; a
  missing provider key must not silently enable mock behavior.
- Use focused tests for behavior changes and describe the checks you ran in a
  pull request. Do not claim a platform or provider was tested when it was
  not.
- Keep third-party code and bundled assets under their original licenses and
  update `THIRD-PARTY-NOTICES.md` when adding one.
- Keep the offline user Help current with every user-facing workflow change:
  update the matching topic, local SVG step images, shortcuts, and first-run
  steps when applicable. Run `npm run check:help` and the `--base` coverage
  check described in `docs/help-maintenance.md`; the gate still requires a
  human review of wording and workflow accuracy.
- The public snapshot also carries generated GitHub Markdown under `docs/help/`.
  Run `npm run docs:help` before `npm run check:help`; keep the JSON guide and
  local SVGs as the source of truth and do not hand-edit generated pages.

## Verification

From a clean checkout with Node.js 22.23.1:

```sh
npm run setup
npm run check
npm test
npm run build
```

Release packaging and public-export checks are described in
`docs/RELEASING.md`. Do not publish a package or run a paid provider request
as part of ordinary review.
