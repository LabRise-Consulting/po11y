# Security policy

## Reporting a vulnerability

Please **do not open a public issue** for a security problem.

Report it as a **confidential issue** on GitLab:
[new issue](https://gitlab.com/labrise/po11y/-/issues/new) → tick
*"This issue is confidential"* before submitting. Only project members can
read it.

Include what you can: affected mode (A/bundled or B/collector), the version or
commit, and a reproduction. You should get an acknowledgement within a week.
Fixes land on `main` with the reporter credited in `CHANGELOG.md` unless you
ask otherwise.

## Supported versions

Po11y has no release branches. `main` is the supported line; fixes are not
backported to older commits.

## Scope

Po11y is a status dashboard for [n8n](https://n8n.io). It has no user
database, no session store and no authorization model of its own — read
`docs/security.md` for the full posture before reporting, because several
sharp edges there are **documented, deliberate design**, not vulnerabilities:

- **No per-viewer read authorization.** Every feed is derived from one
  privileged n8n export. Anyone who can load the dashboard sees all of it.
  This is stated in `docs/security.md` ("Read authorization is out of scope");
  the supported path for real read isolation is Mode B against an n8n with
  projects/RBAC.
- **Anyone with n8n editor access can run JavaScript** in a Code node. That is
  inherent to n8n. Editor access is trusted by definition.
- **Plain HTTP on the default `127.0.0.1` bind.** Put a TLS proxy in front
  before exposing it. The `bootstrap.sh` exposure interlock already refuses a
  non-loopback bind with no `DASHBOARD_BASIC_AUTH`.
- **Mode A enables Execute Command instance-wide** (`NODES_EXCLUDE=[]`) so the
  Maps workflow can run `n8n export:workflow`. Known and tracked; the host
  Docker socket is not mounted into n8n, so it is confined to the container.

In scope, and worth reporting:

- Anything that escapes the container boundary or reaches the host Docker
  daemon.
- A write path to n8n in **Mode B**, which is contractually GET-only.
- Secrets leaking into a published feed, a log line, or anything the browser
  can fetch — the AI-map key and the n8n API key especially.
- Bypasses of `DASHBOARD_BASIC_AUTH`, of the forward-auth overlay's
  `FORM_ALLOWED_GROUPS` gate, or of the `bootstrap.sh` exposure interlock.
- Injection through feed content into the dashboard (the feeds are rendered
  through `esc()`/`safeUrl()` in `html/app.js`; a way past either is a bug).
