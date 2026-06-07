# GitBulk

[![CI](https://github.com/samuelm203/GitBulk/actions/workflows/ci.yml/badge.svg)](https://github.com/samuelm203/GitBulk/actions/workflows/ci.yml)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)

**GitBulk** is a configurable command-line tool for running bulk operations across many Git
repositories at once. Define a code change once, point GitBulk at a list of repositories
("RUs" — repository units), and it clones/updates each one, runs your change, commits, pushes a
feature branch, and opens a pull request — in parallel, with retries, and a clear report at the
end. Cross-platform (Linux, macOS, Windows), with per-repository error isolation.

## Two implementations

GitBulk ships in two independent, feature-equivalent implementations — pick whichever fits your
environment:

| | Implementation | Docs |
| --- | --- | --- |
| **TypeScript / Node.js** | The reference implementation. Runs on a **minimal dependency footprint** (only `yaml` + `zod`; everything else is native Node). Node ≥ 20. | **[README](./node_ts/README.md)** |
| **PowerShell** | A native PowerShell 7.2+ port with the same workflow — no Node runtime required. | **[README](./powershell/README.md)** |

Both define the change per repository via a free **script** *or* a chain of declarative
**operations** (add/replace/delete a file, regex replace, add a Maven/npm dependency, patch JSON),
and automate pull requests on **Bitbucket** (Cloud & Server) and **GitHub** (incl. Enterprise).

## License

Licensed under the **Apache License 2.0**. See [LICENSE](./LICENSE).
