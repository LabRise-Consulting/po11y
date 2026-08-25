# shellcheck shell=sh
# The exposure guard, shared by every entry path that can publish a port.
#
# DASHBOARD_BASIC_AUTH and the forward-auth overlay gate exactly one thing:
# nginx on the dashboard port. BIND_ADDR moves three ports at once, and the
# other two answer without any credential — Grafana with an anonymous Viewer,
# Prometheus with nothing at all. An operator who sets a dashboard password and
# then moves BIND_ADDR off loopback reads that as "the stack is protected", so
# every path that can publish those ports says out loud that it is not.
#
# Sourced, never executed: bootstrap.sh and scripts/readonly-preflight.sh source
# it from the repo, the dashboard entrypoint sources it from the
# ./deploy/nginx mount both compose files already carry. One copy, because a
# warning duplicated per stack is a warning that drifts per stack — the same
# reason the dashboard entrypoint itself is one shared file.
#
# Variables are prefixed _pbg_ so sourcing cannot clobber a caller's names.

# po11y_bind_is_loopback BIND -> 0 when BIND reaches this host only.
# An empty value counts: every compose file defaults BIND_ADDR to 127.0.0.1.
#
# `[::1]` as well as `::1`: a compose port mapping needs the brackets to tell
# the address from the port ("[::1]:3000:3000"), so the bracketed spelling is
# the one an operator who binds IPv6 loopback actually writes into .env.
# Reading it as non-loopback refused to serve on the safest bind there is.
# Unbracketed expanded forms (0:0:...:1) are deliberately absent: compose does
# not accept them in a port mapping, so they cannot reach this function from a
# working configuration.
po11y_bind_is_loopback() {
  case "${1:-}" in
    ""|localhost|::1|"[::1]"|127.*) return 0 ;;
    *) return 1 ;;
  esac
}

# po11y_bind_guard BIND STACK GATE [MODE]
#   BIND   the BIND_ADDR in force
#   STACK  bundled | readonly — which ports exist to warn about
#   GATE   human name of the active dashboard auth gate, empty when there is none
#   MODE   enforce (default) | report — wording only, never the return value
#
# Prints nothing and returns 0 for a loopback bind. Otherwise names every
# published port the gate does not cover, and returns 1 when the bind is
# ungated and PO11Y_ALLOW_OPEN_BIND is not 1. Callers choose what a 1 means:
# bootstrap.sh and the dashboard entrypoint refuse with exit 78 (EX_CONFIG),
# the read-only preflight only reports — which is why MODE exists. A report
# that says REFUSING while the script goes on to exit 0 teaches the reader to
# distrust the next warning too.
po11y_bind_guard() {
  _pbg_bind="${1:-}"
  _pbg_stack="${2:-bundled}"
  _pbg_gate="${3:-}"
  _pbg_mode="${4:-enforce}"

  if po11y_bind_is_loopback "$_pbg_bind"; then
    return 0
  fi

  echo "po11y: WARNING — BIND_ADDR=$_pbg_bind publishes ports that dashboard auth does NOT gate:"
  if [ "$_pbg_stack" = bundled ]; then
    echo "  $_pbg_bind:5678  n8n editor (own login) + unauthenticated /metrics"
  fi
  echo "  $_pbg_bind:3000  Grafana (anonymous Viewer unless DASHBOARD_GRAFANA_EMBED=false)"
  echo "  $_pbg_bind:9090  Prometheus (no auth)"
  echo "  Restrict these at a firewall, or keep BIND_ADDR loopback behind your own proxy."

  if [ -n "$_pbg_gate" ]; then
    echo "po11y: the dashboard port itself is gated by $_pbg_gate."
    return 0
  fi
  if [ "${PO11Y_ALLOW_OPEN_BIND:-}" = 1 ]; then
    echo "po11y: dashboard auth is unset; continuing because PO11Y_ALLOW_OPEN_BIND=1."
    return 0
  fi

  if [ "$_pbg_mode" = report ]; then
    echo "po11y: BIND_ADDR=$_pbg_bind is not loopback and no dashboard auth gate is set."
    echo "  The dashboard will refuse to start on this bind."
  else
    echo "po11y: REFUSING — BIND_ADDR=$_pbg_bind is not loopback and no dashboard auth gate is set."
  fi
  echo "  Set DASHBOARD_BASIC_AUTH=user:password, or add docker-compose.auth.yml"
  echo "  (forward auth), or set PO11Y_ALLOW_OPEN_BIND=1 to accept an open bind."
  return 1
}
