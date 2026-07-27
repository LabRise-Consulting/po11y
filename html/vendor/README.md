# Vendored third-party assets

Po11y has no build step and no runtime npm dependency: the dashboard is static
files served by nginx. Anything a page needs from outside is committed here,
verbatim and unmodified, so the stack keeps working on a box with no internet
access and no package manager.

| file | upstream | version | licence |
|------|----------|---------|---------|
| `mermaid.min.js` | [mermaid-js/mermaid](https://github.com/mermaid-js/mermaid) | 11.4.1 | MIT — [`mermaid.LICENSE`](mermaid.LICENSE) |

## Verifying and updating

Each file is a byte-identical copy of the published dist artifact. Verify:

```sh
shasum -a 256 html/vendor/mermaid.min.js
# a43bc1afd446f9c4cc66ac5dd45d02e8d65e26fc5344ec0ef787f88d6ddb6f9e

curl -sSLf https://unpkg.com/mermaid@11.4.1/dist/mermaid.min.js | shasum -a 256
# must print the same digest
```

To move to a new version, replace the file from the same upstream path,
re-fetch its `LICENSE` alongside it, and update the version and digest above
in the same commit. `site/map.html` is the only consumer.
