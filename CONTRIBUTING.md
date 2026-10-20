# Contributing to CanAI

CanAI is a local content-generation studio. Contributions to the local app,
its documentation, tests, and release tooling are welcome. The public source
release is local-only: it excludes CanAI Cloud, shared network boards,
collaboration, Cloud accounts, bridges, and the separate Cloud server.

## Before you start

Use a clean Git checkout with Node.js 22.23.1. Install the three locked
dependency trees and start the development app:

```sh
npm run setup
npm run dev
```

Do not commit `server/.env`, `server/data/`, generated media, build output, or
local runtime files. Never put a fal.ai key, another service credential, or
private user data in an issue, pull request, test fixture, log, or screenshot.
Use `CANAI_MOCK=1` only when a test explicitly needs mock mode; missing
`FAL_KEY` must not silently enable it.

## Changes and checks

Keep API routes, storage keys, IDs, schemas, and security boundaries stable
unless a change explicitly updates their contract. Preserve user content and
legacy compatibility. Add focused tests for behavior changes and update the
relevant documentation when a user-visible label or workflow changes. For a
user-facing workflow, update its real Help topic in
`client/src/help/content/guide.json`, the affected local SVG step images, and
shortcuts or first-run steps when applicable. Run `npm run check:help` and the
`--base` coverage check from `docs/help-maintenance.md`, then manually review
the wording and controls.

Before opening a pull request, run:

```sh
npm run check
npm test
npm run build
```

For changes that affect packaging, run the platform-specific release checks
described in `docs/RELEASING.md` on the matching operating system. Avoid paid
provider requests while testing and prefer explicit mocks. If a real provider
check is necessary, use a deliberately configured development account and
clearly document what was actually exercised.

## Pull requests

Explain the user-visible result, the files or contracts changed, and the
checks you ran. Keep unrelated formatting or generated files out of the
change. Review the third-party notices when adding a dependency or bundled
asset.

## Contribution terms

You keep copyright in your contribution. By submitting a contribution, you
grant permission for it to be reproduced, modified, and distributed as part
of CanAI under the CanAI Community License 1.0, while third-party components
remain under their original licenses. No copyright assignment or automatic
Contributor License Agreement is required. If your contribution includes
material owned by someone else, confirm that its license permits the proposed
use and add the required notice.
