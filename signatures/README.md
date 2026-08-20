# CLA signature ledger

`version1/cla.json` records who signed [CLA.md](../CLA.md). The
[CLA workflow](../.github/workflows/cla.yml) reads it on every pull request and
appends to it when a contributor comments the signing sentence. The bot commits
those changes straight to `main`, so commits titled "Creating file for storing
CLA Signatures" or "@user has signed the CLA" are expected here.

**Do not delete `version1/cla.json`, even while it is empty.**

The action creates the file on the first pull request it ever sees, and that
same run then fails with "Committers of pull request N have to sign the CLA" —
even when the author is on the workflow's allowlist. The file is created and
read in one pass, so the read finds nothing. Re-running the job passes, with no
other change.

That failure is harmless for a maintainer who knows the cause. It is not
harmless for a first-time contributor, who sees a red check that says their
pull request is rejected. Keeping the file in the repository means nobody meets
it again.

Confirmed on 2026-08-20 against `contributor-assistant/github-action`
`ca4a40a` (v2.6.1), on pull request #1: the first run failed, the re-run
reported "All contributors have signed the CLA" with nothing else changed.
