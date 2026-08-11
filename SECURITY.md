# Security policy

## Reporting vulnerabilities

Do **not** open public issues for security vulnerabilities.

Submit confidential reports using GitLab issues:
[Create confidential issue](https://gitlab.com/labrise/po11y/-/issues/new) and select **"This issue is confidential"**.

Please include:
- Affected deployment mode (Mode A or Mode B).
- Version or commit hash.
- Reproduction steps.

We acknowledge reports within 7 days. Fixes land on `main`, crediting reporters in `CHANGELOG.md` unless requested otherwise.

## Supported versions

Security updates are applied to the `main` branch. Older commits are not backported.

## Scope and design boundaries

Po11y has no internal user directory or session database. The following documented behaviors are **intentional architectural decisions**, not vulnerabilities:

- **No per-user read authorization**: All status feeds originate from single privileged n8n instance exports. Anyone with access to the dashboard can view all feeds. For read isolation, run Mode B against paid n8n instances using native RBAC.
- **Code node JavaScript execution**: Users with n8n editor permissions can run JavaScript in Code nodes by design.
- **Loopback binding by default**: Services bind to `127.0.0.1`. Use a TLS reverse proxy before exposing services to external networks. `bootstrap.sh` blocks non-loopback bindings if `DASHBOARD_BASIC_AUTH` is missing.
- **Mode A Execute Command node**: Enabled instance-wide (`NODES_EXCLUDE=[]`) for workflow exports. Commands run inside the isolated n8n container.

### In-scope security issues

Please report:
- Container escape risks or unauthorized host Docker daemon access.
- Non-GET write requests to n8n in **Mode B**.
- Exposure of credentials or API keys (such as `N8N_API_KEY` or AI API keys) in published feeds, logs, or static web assets.
- Authentication bypasses for `DASHBOARD_BASIC_AUTH`, `FORM_ALLOWED_GROUPS`, or `bootstrap.sh` bind guards.
- Cross-Site Scripting (XSS) in the dashboard UI (`html/app.js`).
