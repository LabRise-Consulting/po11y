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

## Header security

Nginx extracts user identity (email and groups) strictly from internal responses returned by `oauth2-proxy` (`/oauth2/auth`). Client-supplied headers (such as `X-Forwarded-Email` or `X-Auth-Request-*`) are stripped before requests reach downstream services like Grafana or n8n.

## Restricting form execution by group (`FORM_ALLOWED_GROUPS`)

Set `FORM_ALLOWED_GROUPS` to a comma-separated list of authorized OIDC group names. Nginx allows `POST /form/…` requests only if the user's verified group list (`$auth_groups`) contains an allowed group name.

- **Default policy**: When forward-auth is enabled and `FORM_ALLOWED_GROUPS` is empty, all form POST requests return `403 Forbidden`.
- **Validation source**: Groups are validated exclusively against internal `$auth_groups` responses from `oauth2-proxy`.
- **Group name formatting**: Group names must use alphanumeric characters, underscores, or hyphens (`[A-Za-z0-9_-]`). Match checks compare exact token values.
- **Requirement**: `FORM_ALLOWED_GROUPS` requires the forward-auth overlay. Without forward auth, group checks are disabled.
