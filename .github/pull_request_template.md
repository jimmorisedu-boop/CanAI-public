## What changed

<!-- Describe the user-visible result and the affected contracts. -->

## Checks

- [ ] `npm run check`
- [ ] `npm test`
- [ ] `npm run build` (when the client or package changes)
- [ ] Platform packaging or smoke checks (when release files change)

Commands run:

## Safety and scope

- [ ] No provider keys, `server/.env`, `server/data/`, private boards, or
      unredacted logs are included.
- [ ] Any third-party dependency or bundled asset has its original notice and
      license preserved.
- [ ] Paid provider calls were not made, or the exact deliberate check is
      documented here.
- [ ] User-visible docs and terminology are updated when needed.
- [ ] If a user-facing workflow changed, I updated its real Help topic and
      step illustrations (and shortcuts/first steps when relevant), ran
      `npm run check:help` plus the `--base` coverage check, and manually
      reviewed the wording and action labels. Otherwise I explained why this
      is not applicable below.

## Notes for reviewers

<!-- Mention compatibility, migration, follow-up work, or unverified platforms. -->
