# Forward authentication (optional overlay)

`DASHBOARD_BASIC_AUTH` provides single shared password protection. To support individual user logins, offboarding, and group-based permissions, use the OIDC forward-authentication overlay.

This overlay runs an [`oauth2-proxy`](https://oauth2-proxy.github.io/oauth2-proxy/) container. Nginx verifies authentication with `oauth2-proxy` using `auth_request` on every request. Unauthenticated users are redirected to your Identity Provider (IdP).

## Enabling forward auth

Run the overlay on top of your base compose configuration:

```sh
# Bundled stack
docker compose -f docker-compose.yml -f docker-compose.auth.yml up -d

# Read-only stack
docker compose -f docker-compose.readonly.yml -f docker-compose.auth.yml up -d
```

When active, `oauth2-proxy` handles authentication and `DASHBOARD_BASIC_AUTH` is ignored.

## Identity Provider (IdP) configuration

Configure generic OIDC settings in `.env`. Set `OAUTH2_PROXY_OIDC_ISSUER_URL`, client credentials, and a cookie secret (see `.env.example` for details):

- **Keycloak**: `https://idp.example.com/realms/<realm>`
- **Authentik**: `https://idp.example.com/application/o/<app-slug>/`
- **Google**: `https://accounts.google.com`
- **GitLab**: `https://gitlab.com`

Set `http(s)://<dashboard-host>/oauth2/callback` as the authorized redirect URI in your IdP.

### Who may sign in

`OAUTH2_PROXY_EMAIL_DOMAINS` is required and has no default. Set your organization's domain, or several separated by commas. Authenticating with the IdP is not the same as belonging to your team: with a public issuer such as Google, `*` admits every account that issuer will authenticate. Use `*` only when something else already limits who the IdP authenticates.

### Session lifetime and offboarding

`OAUTH2_PROXY_COOKIE_REFRESH` (default `1h`) sets how often oauth2-proxy revalidates a live session against the IdP. `OAUTH2_PROXY_COOKIE_EXPIRE` (default `8h`) sets how long a session lasts.

Revocation is not immediate. A user you disable in the IdP keeps their session until the next refresh, so allow up to `OAUTH2_PROXY_COOKIE_REFRESH` for access to end. Shorten the interval if you need a faster response. Do not remove it: with no refresh interval, nothing is revalidated and a disabled account keeps working until its cookie expires. Keep `OAUTH2_PROXY_COOKIE_EXPIRE` at or below the refresh-token lifetime your IdP issues.

Refresh needs a refresh token, which most IdPs issue only for the `offline_access` scope. Without one, oauth2-proxy revalidates the ID token locally instead of asking the IdP, and `OAUTH2_PROXY_COOKIE_EXPIRE` becomes the real bound on how long a revoked account keeps access. Check that your IdP issues a refresh token if you rely on the one-hour figure; the expiry always holds.

### Large sessions (split cookies)

A session over 4kB does not fit in one cookie, so oauth2-proxy splits it across `_oauth2_proxy_0`, `_oauth2_proxy_1` and so on. Nginx's `auth_request` exposes only the first `Set-Cookie` header, so forwarding a refreshed split session would leave the browser holding a new part 0 beside a stale part 1 — a session that no longer decodes, and a sign-in redirect on the next request.

The dashboard detects the split by reading `$upstream_cookie__oauth2_proxy_1`, and withholds the header entirely when it is present. The browser then keeps its intact pre-refresh cookie: refresh stops taking effect for that deployment, and `OAUTH2_PROXY_COOKIE_EXPIRE` becomes the bound on revocation again, but no session breaks.

Sessions grow with the size of the tokens your IdP issues, so this affects IdPs with large ID tokens or many group claims. If it affects yours, configure a server-side session store (`OAUTH2_PROXY_SESSION_STORE_TYPE=redis` and a Redis instance you run). The cookie then holds only a ticket, which never splits and never changes on refresh, so refresh works with no nginx involvement at all. This is upstream's own recommendation; reassembling split cookies in nginx is documented but fragile, handles only two parts, and hard-codes the cookie name. The overlay pins `OAUTH2_PROXY_COOKIE_NAME=_oauth2_proxy` because the detection above derives an nginx variable name from it.

The dashboard also has to hand the refreshed cookie back to the browser. Nginx discards the `auth_request` subrequest's `Set-Cookie`, so the entrypoint renders the `auth_request_set $auth_cookie` / `add_header Set-Cookie` pair that upstream prescribes for `--cookie-refresh`, and every location with its own `add_header` restates it — nginx inherits `add_header` only into levels that declare none. Without that, the browser keeps presenting the pre-refresh cookie, and an IdP that rotates refresh tokens rejects the replay and forces a sign-in redirect.

## Header security

Nginx extracts user identity (email and groups) strictly from internal responses returned by `oauth2-proxy` (`/oauth2/auth`). Client-supplied headers (such as `X-Forwarded-Email` or `X-Auth-Request-*`) are stripped before requests reach downstream services like Grafana or n8n.

## Restricting form execution by group (`FORM_ALLOWED_GROUPS`)

Set `FORM_ALLOWED_GROUPS` to a comma-separated list of authorized OIDC group names. Nginx allows `POST /form/…` requests only if the user's verified group list (`$auth_groups`) contains an allowed group name.

- **Default policy**: When forward-auth is enabled and `FORM_ALLOWED_GROUPS` is empty, all form POST requests return `403 Forbidden`.
- **Validation source**: Groups are validated exclusively against internal `$auth_groups` responses from `oauth2-proxy`.
- **Group name formatting**: Group names must use alphanumeric characters, underscores, or hyphens (`[A-Za-z0-9_-]`). Match checks compare exact token values.
- **Requirement**: `FORM_ALLOWED_GROUPS` requires the forward-auth overlay. Without forward auth, group checks are disabled.

## What forward auth does not cover

Four limits. None is a defect in the overlay; each is a boundary to plan around.

- **Two ports bypass it entirely.** oauth2-proxy sits in front of nginx only. Grafana on port 3000 and Prometheus on port 9090 are published by `BIND_ADDR` alongside the dashboard, and neither passes through nginx. A request to `/grafana/` is authenticated; a request to port 3000 is not. This is the same limit `DASHBOARD_BASIC_AUTH` has, so switching to OIDC does not close it — see [security.md](security.md).
- **Grafana receives no identity.** Nginx blanks every identity header before proxying to Grafana, and sets no `X-WEBAUTH-USER`. Every authenticated user therefore reaches Grafana as the same anonymous Viewer. Grafana keeps no per-user audit trail and applies no per-user permissions, and administration remains one shared account.
- **Groups gate one route.** `$auth_groups` is read only by the `/form/` block. Read access to the feeds, the map, `/grafana/`, `/prom/`, `/mcp/` and `POST /rebuild` is the same for everyone who signs in. See "Read authorization scope" in [security.md](security.md).
- **`/mcp/` stops working for machine clients.** The MCP route sits behind the same gate, and a machine client cannot complete a browser redirect. The overlay configures no `skip-auth-routes` and no bearer-token path, so an MCP client cannot reach a dashboard running forward auth.

Two configuration notes:

- `OAUTH2_PROXY_COOKIE_SECURE` defaults to `false`, which is required for a plain-HTTP loopback bind. Over any real network the session cookie travels in clear text and anyone who captures it holds the session. Set it to `true` as soon as TLS is in front.
- A group name that contains characters outside `[A-Za-z0-9_-]` is filtered before it reaches the match, while oauth2-proxy keeps emitting the original. A Keycloak group path such as `/team-a` therefore never matches, and the entry denies silently. The dashboard logs a notice at start naming any entry this affects. Configure the IdP to emit group names without slashes.
