# n8n, unmodified apart from the build arg below.
#
# This image used to layer in the static docker CLI so a status-publish
# workflow's Execute Command node could run `docker ps` against the host
# daemon, and to pre-create /po11y-status for the shared feed volume. Both
# workflows are deleted, the volume is unmounted, and the po11y server owns
# every feed — so neither the CLI nor the directory is here any more.
#
# N8N_IMAGE is overridable so the nightly CI job can build against
# n8nio/n8n:latest and catch upstream breakage of the internal /rest/ API the
# bootstrap uses. Declared before the first FROM so it is usable in FROM lines.
ARG N8N_IMAGE=docker.io/n8nio/n8n:2.29.8

FROM ${N8N_IMAGE}
