# Security policy

CanAI runs a local server and browser client. Optional Cloud integrations use
separate hosted services; the Cloud server is not part of this public source
release. Security reports for the local app, release packages, and included
scripts are welcome.

## Supported versions

The current `0.1.x` release-candidate line receives security fixes while it is
the supported public line. Older snapshots may not receive fixes; update to a
current checkout before investigating a report.

## Reporting a vulnerability

When private vulnerability reporting is enabled for the repository, use the
**Security** tab's private reporting flow. Do not publish exploit details in a
public issue before maintainers can review them privately. If that private
channel is not enabled, open a minimal public issue asking maintainers to
enable a private channel and do not include the exploit, credentials, private
boards, or user data.

Include the affected version or commit, platform, a concise description of the
impact, reproduction steps that use synthetic data, and any proposed fix. Give
maintainers reasonable time to investigate before public disclosure.

## Protecting secrets and data

Never attach `server/.env`, API keys, cookies, private boards, `server/data/`,
or unredacted logs to an issue or pull request. Revoke and rotate a key that
may have been exposed, then report the exposure through the private channel
when available. Test fixtures and screenshots must use synthetic content.

The local app sends a provider key only when you configure one. Keep
`CANAI_MOCK=1` explicit in development and do not treat mock output as proof
that a real provider or Cloud integration is secure.
