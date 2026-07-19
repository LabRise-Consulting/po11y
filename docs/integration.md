# Using Po11y inside an existing stack

The dashboard is just static files plus a config, so you can mount it into a
compose stack you already have:

```yaml
# docker-compose.yml
dashboard:
  image: nginx:1.27-alpine
  ports: ["8080:80"]
  volumes:
    - ./external/po11y/html:/usr/share/nginx/html:ro
    - ./external/po11y/nginx.conf:/etc/nginx/conf.d/default.conf:ro  # or your copy
    - ./dashboard/site:/usr/share/nginx/site:ro                      # your tab pages
    - ./dashboard/config.json:/run/po11y/config.json:ro              # your config
    - status-volume:/po11y-status:ro                                 # your publisher writes here
```

(If you use the `/n8n-table/` proxy, render `nginx.conf`'s
`${N8N_READ_API_KEY}` reference yourself before mounting it — see the
`dashboard` service entrypoint in this repo's `docker-compose.yml` for the
one-line `envsubst` that does it.)

Pin Po11y as a git submodule so updates are deliberate:

```sh
git submodule add https://gitlab.com/labrise/po11y external/po11y
```

## Feeding it from n8n

The dashboard only reads files; n8n writes them. Two prerequisites on the n8n
service, then one small scheduled workflow.

Existing n8n: mount the shared volume and allow the `fs` builtin in Code
nodes, then restart:

```yaml
n8n:
  environment:
    - NODE_FUNCTION_ALLOW_BUILTIN=fs
  volumes:
    - status-volume:/po11y-status
```

New n8n: add the service next to the dashboard in the same compose file:

```yaml
n8n:
  image: n8nio/n8n:latest
  ports: ["5678:5678"]
  environment:
    - NODE_FUNCTION_ALLOW_BUILTIN=fs
  volumes:
    - n8n_data:/home/node/.n8n
    - status-volume:/po11y-status
```

Either way, create a workflow: a Schedule Trigger (every 1 to 2 minutes) into
a Code node that gathers whatever you want on the dashboard and writes the
status contract atomically (tmp file, then rename, so nginx never serves a
half-written file):

```js
const fs = require('fs');
const status = {
  generated_at: new Date().toISOString(),
  // fill from earlier nodes: docker ps output, API calls, queue depths, ...
  containers: [],
};
fs.writeFileSync('/po11y-status/status.json.tmp', JSON.stringify(status));
fs.renameSync('/po11y-status/status.json.tmp', '/po11y-status/status.json');
return [{ json: { published: true } }];
```

A second workflow (or the same one) can append to `notifications.json` the
same way. A first card for `config.json` is the n8n editor itself:
`{"name": "n8n", "sub": "workflow editor", "href": "http://{host}:5678/"}`.

Instead of writing a publisher from scratch, you can also import
[`workflows/core/*.json`](../workflows/core) (status publisher and maps) into
your existing n8n directly. Mount your status volume at `/po11y-status` in
that n8n and the write paths match.
