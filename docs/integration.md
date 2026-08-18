# Integrating Po11y into an existing stack

You can mount the Po11y dashboard into an existing Docker Compose stack using static files, a configuration template, and the po11y `server` process. n8n needs no po11y workflows installed — the server polls it read-only, the same way `docker-compose.readonly.yml` does.

## Nginx template configuration

`nginx.conf` acts as a template containing required configuration includes (`auth.conf`, `forward-auth.conf`, `form-proxy.conf`, `feeds.conf`) that must be rendered before nginx starts. Do not mount it directly to `/etc/nginx/conf.d/default.conf`. It carries no environment variable placeholders — `N8N_READ_API_KEY` is configured on the `server` service (which also answers `/mcp` and `/n8n-table`) and every remaining `$var` in the file is an nginx runtime variable, so rendering `default.conf` is a plain copy, not an `envsubst` substitution. `feeds.conf` is the one exception: it is rendered from `deploy/nginx/feeds-server.conf` by substituting `__FEED_UPSTREAM__` — see [`deploy/nginx/dashboard-entrypoint.sh`](../deploy/nginx/dashboard-entrypoint.sh) for the exact `sed` command, and reuse it rather than reinventing the substitution.

Mount `nginx.conf` as a template file and generate `default.conf` at container startup:

```yaml
# docker-compose.yml
dashboard:
  image: nginx:1.27-alpine
  ports: ["8080:80"]
  volumes:
    - ./external/po11y/html:/usr/share/nginx/html:ro
    - ./external/po11y/nginx.conf:/etc/nginx/nginx.conf.template:ro
    - ./external/po11y/deploy/nginx:/etc/nginx/po11y-feeds:ro
    - ./dashboard/site:/usr/share/nginx/site:ro
    - ./dashboard/config.json:/run/po11y/config.json:ro
  entrypoint:
    - sh
    - -euc
    - |
      cp /etc/nginx/nginx.conf.template /etc/nginx/conf.d/default.conf
      : > /etc/nginx/auth.conf
      : > /etc/nginx/forward-auth.conf
      : > /etc/nginx/form-proxy.conf
      sed "s|__FEED_UPSTREAM__|http://server:8081|g" \
        /etc/nginx/po11y-feeds/feeds-server.conf > /etc/nginx/feeds.conf
      exec nginx -g 'daemon off;'
```

To add Po11y as a git submodule:

```sh
git submodule add https://github.com/labrise-consulting/po11y external/po11y
```

## Running the server against your n8n

The dashboard's feeds — `status.json`, `map.json`, `forms.json`, `ai-map.json`, `notifications.json` — all come from the po11y `server` process, proxied by nginx as configured above. There is nothing to install on n8n: the server polls n8n's public REST API read-only (GET only, enforced in code). Add the server as its own service, pointed at your existing n8n:

```yaml
# docker-compose.yml
server:
  build:
    context: ./external/po11y
    dockerfile: server/Dockerfile
  environment:
    N8N_API_URL: http://n8n:5678          # or the remote n8n's base URL
    N8N_API_KEY: ${N8N_API_KEY}           # a public-API key, GET-only use
  volumes:
    - po11y_store:/data
```

See [docs/server.md](server.md) for the full environment reference, and `docker-compose.readonly.yml` in this repository for a complete, working example of this same pattern.
