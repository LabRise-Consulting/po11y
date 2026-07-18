# n8n (hardened image — no package manager) extended with the static docker CLI
# so the status-publish workflow's Execute Command node can run `docker ps`
# against the host daemon (socket mounted in docker-compose.yml).
#
# N8N_IMAGE is overridable so the nightly CI job can build against
# n8nio/n8n:latest and catch upstream breakage of the internal /rest/ API the
# bootstrap uses. Declared before the first FROM so it is usable in FROM lines.
ARG N8N_IMAGE=docker.io/n8nio/n8n:2.29.8

FROM docker.io/docker:cli AS dockercli

FROM ${N8N_IMAGE}
COPY --from=dockercli /usr/local/bin/docker /usr/local/bin/docker
# Pre-create the status mount point owned by the runtime user: docker copies
# ownership from the image path when it initializes a fresh named volume —
# without this the volume comes up root-owned and every status write EACCESes.
USER root
RUN mkdir -p /po11y-status && chown node:node /po11y-status
USER node
