# Changelog

Notable changes to Po11y. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the project is not
versioned yet, so `main` is the only line.

## [Unreleased]

### Added

- `SECURITY.md`: confidential-issue disclosure process, plus an explicit
  in-scope/out-of-scope list so the documented design trade-offs in
  `docs/security.md` don't get re-reported as vulnerabilities.
- `CONTRIBUTING.md`: the full local check suite, the `lib/` →
  `tools/sync-workflows.mjs` → `maps.json` loop, and the project conventions.
- `html/vendor/README.md` and `html/vendor/mermaid.LICENSE`: provenance,
  version and SHA-256 for the vendored Mermaid build, which shipped with no
  attribution despite being MIT-licensed.

### Changed

- CI: every validate-stage job (`test`, `sync-check`, `lint`, `interlock`,
  `compose-config`, `manifests`) is now untagged and runs on stock GitLab
  shared runners. Previously all jobs were pinned to a self-hosted runner, so
  a fork or an outside merge request got no pipeline at all. `smoke` still
  needs a privileged dind host and is now restricted to the canonical project
  instead of hanging on a tag nobody else provides.
- A missing or unreadable `/config.json` now says so in the dashboard lede
  instead of silently falling back to built-in defaults and rendering an empty
  page.
- The Mode B quickstart creates `config.json` before the first `up`. Both
  compose files bind-mount it, so without that step docker created a
  *directory* of that name and the dashboard came up blank.

### Removed

- `docs/video/` and `docs/intro.mp4` removed and stripped from history. The
  rendered video was 25 MB of a 78 MB clone, and Remotion is not MIT-licensed
  — it requires a paid company licence above three people, which does not
  belong in an MIT repo's dependency tree. The Remotion source moved to a
  separate repository; the rendered mp4 is now a project upload that the
  README links, so it costs the clone nothing.
- `docs/superpowers/` (local planning output) removed and stripped from history.
