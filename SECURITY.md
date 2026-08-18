# Security policy

## Reporting vulnerabilities

Do **not** open public issues for security vulnerabilities.

Submit private reports using GitHub security advisories:
[Report a vulnerability](https://github.com/labrise-consulting/po11y/security/advisories/new). The report stays private
between you and the maintainers until an advisory is published.

Please include:
- Affected deployment topology (bundled or read-only).
- Version or commit hash.
- Reproduction steps.

We acknowledge reports within 7 days. Fixes land on `main`, crediting reporters in `CHANGELOG.md` unless requested otherwise.

## Supported versions

Security updates are applied to the `main` branch. Older commits are not backported.

## Scope and design boundaries

Po11y has no internal user directory or session database. The following documented behaviors are **intentional architectural decisions**, not vulnerabilities:

- **No per-user read authorization**: All status feeds originate from the po11y server's own read-only n8n API access. Anyone with access to the dashboard can view all feeds. For read isolation, run the read-only stack against paid n8n instances using native RBAC.
- **Code node JavaScript execution**: Users with n8n editor permissions can run JavaScript in Code nodes by design.
- **Loopback binding by default**: Services bind to `127.0.0.1`. Use a TLS reverse proxy before exposing services to external networks. `bootstrap.sh` blocks non-loopback bindings if `DASHBOARD_BASIC_AUTH` is missing.

### In-scope security issues

Please report:
- Container escape risks or unauthorized host Docker daemon access.
- Non-GET write requests to n8n from the po11y **server**.
- Exposure of credentials or API keys (such as `N8N_API_KEY` or AI API keys) in published feeds, logs, or static web assets.
- Authentication bypasses for `DASHBOARD_BASIC_AUTH`, `FORM_ALLOWED_GROUPS`, or `bootstrap.sh` bind guards.
- Cross-Site Scripting (XSS) in the dashboard UI (`html/app.js`).
