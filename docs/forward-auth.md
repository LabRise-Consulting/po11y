# Forward auth (optional overlay)

`DASHBOARD_BASIC_AUTH` is a single shared password: it can prove *a* password
was known, never *who* is on the other end, so it cannot survive offboarding.
The forward-auth overlay replaces it with real OIDC login: every request
carries a verified identity (email + group membership), and removing someone
in your IdP removes their access here, with nothing to rotate.

It is an **opt-in overlay** — Basic Auth stays the zero-config default. Bring
it up on top of either base stack (order matters; the overlay goes second):

```sh
# Mode A (bundled)
docker compose -f docker-compose.yml          -f docker-compose.auth.yml up -d
# Mode B (collector)
docker compose -f docker-compose.readonly.yml -f docker-compose.auth.yml up -d
```

The overlay adds an [`oauth2-proxy`](https://oauth2-proxy.github.io/oauth2-proxy/)
container that nginx consults on every request via `auth_request`;
unauthenticated users are bounced to the IdP and back. It publishes no new
port — oauth2-proxy is reachable only on the compose network. When the overlay
is active, `DASHBOARD_BASIC_AUTH` is ignored (forward-auth wins).

## IdP configuration

It is a **generic OIDC** client — any compliant IdP works, only the issuer URL
changes. Set `OAUTH2_PROXY_OIDC_ISSUER_URL`, plus client id/secret and a
cookie secret — see the "forward auth" block in
[`.env.example`](../.env.example), which includes the `openssl` one-liner for
the cookie secret.

- **Keycloak** — `https://idp.example.com/realms/<realm>`
- **Authentik** — `https://idp.example.com/application/o/<app-slug>/`
- **Google** — `https://accounts.google.com`
- **GitLab** — `https://gitlab.com` (or your self-managed base URL)

Register `http(s)://<dashboard host>/oauth2/callback` as the app's redirect URI.

## Identity provenance

nginx reads the signed-in email and groups *only* from oauth2-proxy's
`/oauth2/auth` subrequest **response** (via `auth_request_set`), never from
client-supplied request headers. A request that arrives with its own
`X-Auth-Request-*` / `X-Forwarded-Email` headers is ignored for access
control, and those headers are scrubbed before nginx proxies to Grafana or
n8n, so no upstream can mistake a forged header for a real login.

## Authorizing form firing per group (`FORM_ALLOWED_GROUPS`)

Verified group membership is what turns the all-or-nothing form proxy into
something defensible on a shared box. Set `FORM_ALLOWED_GROUPS` to a
comma-separated list of OIDC group names; nginx then allows a `POST /form/…`
only when the request's verified `$auth_groups` contains one of them.

- **Deny by default.** With the overlay on and `FORM_ALLOWED_GROUPS` *empty*,
  every form POST is refused with `403`.
- **Only the verified identity counts.** The allowlist is matched against
  `$auth_groups` from oauth2-proxy's subrequest response — never a
  client-supplied `X-Forwarded-Groups`. The `/form/` proxy also scrubs inbound
  `X-Auth-Request-*` / `X-Forwarded-*` before reaching n8n.
- **No overlay, no enforcement.** Without forward-auth there is no verified
  identity to check, so `FORM_ALLOWED_GROUPS` has no effect; if you set it
  anyway the dashboard logs a start-up notice rather than pretend to enforce
  it.
- **Group name shape.** Names are whitelisted to `[A-Za-z0-9_-]` and matched
  as whole comma-delimited tokens. If your IdP emits group *paths* (e.g.
  Keycloak's `/team-a`), configure the groups claim to emit slash-free names.

**Why an env var, not `config.json`:** `config.json` is browser-served; this
authorization is enforced in nginx. Putting the policy in an env var at the
enforcement point keeps it honest.

**Honest scope:** like the Kubernetes manifests, this overlay is
**config-validated, not smoke-tested** in CI — `docker compose config` proves
both modes merge with it cleanly, but the live OIDC round-trip needs a real
IdP and is exercised manually, not in the pipeline.
