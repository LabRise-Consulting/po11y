# Mode B collector — a standalone read-only poller. Zero runtime dependencies
# (built-in fetch/http/fs only), so there is nothing to `npm install`: just the
# source on a stock Node 22 image.
#
# Hardened by construction: runs as the non-root `node` user, needs no shell at
# runtime, and works under a read_only rootfs — it writes ONLY to the mounted
# STATUS_DIR volume (tmp+rename happens inside that same dir, so no OS tmpdir is
# needed either).
FROM node:22-alpine

WORKDIR /app
# lib/ ships alongside collector/ because collect.mjs imports ../lib builders.
COPY lib ./lib
COPY collector ./collector

USER node
# STATUS_DIR (default /po11y-status) is a bind/volume mount provided at runtime.
EXPOSE 8081
CMD ["node", "collector/index.mjs"]
