# n8n, unmodified apart from the build arg below.
#
# N8N_IMAGE is overridable so the nightly CI job can build against
# n8nio/n8n:latest and catch upstream breakage of the internal /rest/ API the
# bootstrap uses. Declared before the first FROM so it is usable in FROM lines.
ARG N8N_IMAGE=docker.io/n8nio/n8n:2.29.8

FROM ${N8N_IMAGE}
