# Public release checklist

This file is the public release guide. A clean public export places it at
`docs/RELEASING.md`.

## Official snapshots and contributor builds

| Role | Maintainer checkout | GitHub repository |
| --- | --- | --- |
| Development | `F:\Exp\CanAI` | `jimmorisedu-boop/CanAI` |
| Production and releases | `F:\Exp\CanAI-public` | `jimmorisedu-boop/CanAI-public` |

The production repository contains the generated **local edition** for public
distribution. Its name does not grant permission to change GitHub visibility;
verify the actual visibility and change it only when the owner explicitly
requests it. Do everyday maintainer development
in the development checkout. These repositories do not synchronize in the
background.

The official public source is generated from the private **CanAI-dev**
authoring checkout. This guide does not expose private Git history. A
contributor's fork, source ZIP, or local build is useful for review and
development, but it is not the official authoring repository or an official
release by itself.

Maintainers prepare an official snapshot from a clean, committed authoring
checkout with:

```sh
npm run release:prepare
```

Use `npm run release:prepare -- --help` to list the available flags.

The command creates or refreshes `..\CanAI-public` and writes the full release
to `artifacts/public-release/<version>-<short-authoring-commit>/`. A
`--source-only` run uses a separate `-source-only` directory and
`artifacts/public-release/latest-source.json`; `latest.json` is updated only
after the full gate succeeds. Provenance records both the authoring and
generated public revisions.
Intermediate release files, the source export, and the candidate Git checkout
stay in the authoring project's `artifacts/.tmp/canai-release-prepare-*/`.
Successful runs remove that workspace; failed runs retain it there for
diagnostics. `release:public:check` also uses `artifacts/.tmp/`. Source export
without `--output` defaults to `artifacts/public-source/<revision>/`.
Native `make-dist.ps1` / `make-dist.sh` builds remain in the owning project's
`dist-package/`. Keep manual exports, backups, and worktrees inside their
project's `artifacts/`, `releases-archive/`, or `.worktrees/`; do not create
extra release or candidate folders beside the projects. The canonical
`CanAI-public` checkout keeps its established sibling path.
Finalization publishes the candidate, seals the immutable artifact directory,
then updates the success pointer. If a late step fails, rerun the same command:
a matching sealed artifact is reused. Never replace an existing artifact
directory or delete an older snapshot; stop and investigate a mismatched path.
Community changes are welcome in public forks; accepted changes are ported to
**CanAI-dev** and exported again. Publish the checked snapshot identified by
the success pointer; never publish the authoring checkout or private Git
history directly.

The gate expects Git and Node.js 22.23.1. The wrapper selects an existing
portable `runtime/node` automatically; otherwise Node.js 22.23.1 must be on
`PATH`. It then runs locked installs, checks, Help validation, tests, audits,
mandatory Gitleaks, checksums, provenance, and native launcher smoke tests.
Pass `--source-only` only for a diagnostic source export; it still runs source
checks, `check`, Help, tests, audits, and secret scans, and skips only the
native package and smoke checks. An explicit `--gitleaks <path>` is optional
because the command can install the pinned scanner. The gate keeps the local
Express backend, local boards, fal.ai generation, and tablet access to the
owner's computer over LAN. It excludes CanAI Cloud clients and servers,
shared network boards, collaboration, Cloud bridges, credentials, personal
data, and local runtime state. The source manifest records `edition: local`.
The exporter applies local source filters and committed overrides; historical
snapshots without an edition marker are accepted only as migration input.
Report
Windows/macOS and CI results only when the corresponding check ran; a blocked
CI workflow is not a pass.
Public release publication remains a separate explicit action.

If the existing `CanAI-public` checkout contains legacy private history, archive
that checkout before preparing the next release and replace it with the approved
single-root local snapshot. Candidate creation clones the current public refs,
including their parents and tags, so a stale checkout would carry that history
into the candidate. Verify the replacement has only the intended local history
before running the release command.

## Publishing to the production repository

After preparation, read `artifacts/public-release/latest.json` in the
development checkout. Its `sourceRevision` must match development HEAD and
its `publicCommit` must match production HEAD. Verify a clean production
checkout, its origin, and the repository visibility before pushing:

```powershell
git -C F:\Exp\CanAI-public status --short
git -C F:\Exp\CanAI-public remote get-url origin
gh repo view jimmorisedu-boop/CanAI-public --json nameWithOwner,visibility
```

The expected production origin is
`https://github.com/jimmorisedu-boop/CanAI-public.git`, and the expected
visibility must match the owner's approved publication plan. Keep any legacy
archive private. Push only the generated `main` branch:

```powershell
git -C F:\Exp\CanAI-public push origin main
```

Create a version tag on the checked `publicCommit`. Attach the source ZIP,
the package for the verified platform, and their `.sha256` sidecars from the
artifact directory named by `latest.json`. Write release notes in English
and state which checks and platforms actually ran. Do not attach local logs,
credentials, personal data, or private authoring history. Never overwrite a
released tag or package; increment the version for a subsequent release.
Pushing code or creating a GitHub Release must not change repository
visibility. Never use `--mirror` to publish the development checkout.

The current public target is the `0.1.2` release candidate. Use a clean Git
checkout and record the exact commit for every artifact. Do not add provider
keys, personal data, local runtime files, or a private Cloud service to an
archive.

## Advanced source and dependency checks

The following multi-step commands are for contributor or diagnostic verification.
The single release command above is the canonical official flow.

Use Node.js 22.23.1 on the platform being packaged:

```sh
npm ci --no-fund --no-audit
npm --prefix server ci --no-fund --no-audit
npm --prefix client ci --no-fund --no-audit
npm run check
npm test
npm run build
npm audit --omit=dev --audit-level=high
npm --prefix server audit --omit=dev --audit-level=high
npm --prefix client audit --omit=dev --audit-level=high
```

Run the public source export and its directory secret scan before publishing
an archive. The export command maps `docs/public/AGENTS.md` to `AGENTS.md` and
this file to `docs/RELEASING.md`:

```sh
node scripts/export-public-source.mjs --output artifacts/public-source/review
node scripts/install-gitleaks.mjs --output artifacts/tools/gitleaks
node scripts/scan-secrets.mjs --source artifacts/public-source/review --mode dir --require-gitleaks --gitleaks <binary-path-printed-by-installer>
```

The public export includes the runtime agent schemas, examples, and
`docs/agents/README.md`. It excludes the internal Cloud and implementation
notes (`docs/agents/CLOUD.md`, `docs/agents/IMPLEMENTATION.md`), internal
plans, and relay operations. Keep those exclusions when preparing a clean
source tree.

## Platform packages

The documented production targets are Windows x64 and macOS Apple Silicon
(arm64). Linux is a CI check platform only; no Linux production package is
claimed.

On Windows, build the release ZIP with `make-dist.ps1`, then unpack it into a
new temporary folder and run the native launcher smoke test:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\make-dist.ps1
node scripts/smoke-distribution.mjs <unpacked-release-dir> --platform windows
```

On macOS Apple Silicon, build the pinned media tools first, then package and
smoke-test the native launcher:

```sh
zsh scripts/build-ffmpeg-macos.sh
zsh make-dist.sh
node scripts/smoke-distribution.mjs <unpacked-release-dir> --platform macos
```

The smoke test must exercise start, readiness, stop, and restart with an empty
data directory. Compare the ZIP's SHA-256 with its sidecar file and retain a
provenance record containing the source commit, platform, architecture, and
checks performed. Keep verification ZIPs and checksums as CI artifacts; this
guide does not publish a GitHub Release or upload a public package.

Report native macOS or Windows verification only after the build and launcher
checks have passed on that platform for the source being released. Record
whether the checks ran locally or in CI; a blocked workflow is not a CI pass.

## Archive contents

An archive contains the prebuilt local client, local server, portable launchers,
agent schemas/examples, `LICENSE`, public guides, third-party notices, and the
full component license texts. It does not contain `server/.env`, `server/data/`,
installed dependencies, private runtime data, or the closed Cloud server.
The developer-only `update.ps1` and `Update CanAI.bat` are omitted from the
public source snapshot and release archives. Update a portable installation by
extracting a new release ZIP and migrating its data.
