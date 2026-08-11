# Integrating Po11y into an existing stack

You can mount the Po11y dashboard into an existing Docker Compose stack using static files and a configuration template.

## Nginx template configuration

`nginx.conf` acts as a template containing environment variable placeholders (`${N8N_READ_API_KEY}`) and required configuration includes. Do not mount it directly to `/etc/nginx/conf.d/default.conf`.

Mount `nginx.conf` as a template file and generate `default.conf` using `envsubst` at container startup:

```yaml
# docker-compose.yml
dashboard:
  image: nginx:1.27-alpine
  ports: ["8080:80"]
  volumes:
    - ./external/po11y/html:/usr/share/nginx/html:ro
    - ./external/po11y/nginx.conf:/etc/nginx/nginx.conf.template:ro
    - ./dashboard/site:/usr/share/nginx/site:ro
    - ./dashboard/config.json:/run/po11y/config.json:ro
    - status-volume:/po11y-status:ro
  entrypoint:
    - sh
    - -euc
    - |
      N8N_READ_API_KEY="$${N8N_READ_API_KEY:-}" \
        envsubst '$${N8N_READ_API_KEY}' \
        < /etc/nginx/nginx.conf.template > /etc/nginx/conf.d/default.conf
      : > /etc/nginx/auth.conf
      : > /etc/nginx/forward-auth.conf
      : > /etc/nginx/form-proxy.conf
      exec nginx -g 'daemon off;'
```

To add Po11y as a git submodule:

```sh
git submodule add https://gitlab.com/labrise/po11y external/po11y
```

## Publishing status feeds from n8n

To allow an existing n8n instance to write status files, mount the shared volume and enable the built-in `fs` module:

```yaml
n8n:
  environment:
    - NODE_FUNCTION_ALLOW_BUILTIN=fs
  volumes:
    - status-volume:/po11y-status
```

### Example status writer workflow

Create a scheduled n8n workflow (e.g. running every 1–2 minutes) with a Code node that writes `/po11y-status/status.json` atomically:

```js
const fs = require('fs');
const status = {
  generated_at: new Date().toISOString(),
  containers: []
};
fs.writeFileSync('/po11y-status/status.json.tmp', JSON.stringify(status));
fs.renameSync('/po11y-status/status.json.tmp', '/po11y-status/status.json');
return [{ json: { published: true } }];
```

Alternatively, import the pre-built workflows from [`workflows/core/*.json`](../workflows/core) directly into your n8n instance.
