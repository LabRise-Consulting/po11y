# Po11y MCP server — read-only MCP over streamable HTTP. Zero runtime
# dependencies (built-in fetch/http/fs only), so there is nothing to
# `npm install`: just the source on a stock Node 22 image.
#
# Hardened by construction: runs as the non-root `node` user, needs no shell at
# runtime, works under a read_only rootfs, and writes nothing at all — every
# mount it has is read-only.
FROM node:22-alpine

WORKDIR /app
# lib/ for the shared row walk, collector/ for the GET-only apiGet choke point
# and the watchdog verdict helpers.
COPY lib ./lib
COPY collector ./collector
COPY mcp ./mcp

USER node
EXPOSE 8082
CMD ["node", "mcp/index.mjs"]
