FROM node:24-alpine

WORKDIR /app
COPY server/ ./server/
COPY lib/ ./lib/

RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data

# BIND_HOST is 0.0.0.0 because nginx reaches this over the compose network and
# the port is NOT published to the host by either base compose file — every
# route it serves (/mcp, /n8n-table, the feeds) is reached through nginx, which
# is where the dashboard's auth lives. The write path is closed unless
# PO11Y_INGEST_TOKEN is set.
#
# NODE_OPTIONS silences node:sqlite's ExperimentalWarning, which this base
# image emits, so the log is not one warning per boot.
ENV PO11Y_DB=/data/po11y.db PORT=8081 BIND_HOST=0.0.0.0 NODE_OPTIONS=--no-warnings=ExperimentalWarning
EXPOSE 8081

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8081)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.mjs"]
