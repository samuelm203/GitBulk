# GitBulk

> Configurable CLI tool for bulk operations on Git repositories.

GitBulk lässt dich definierte Git-Operationen (Klonen, Pullen, Branches anlegen,
Code-Änderungen ausführen, Commit & Push) konfigurationsgesteuert über viele
Repositories hinweg ausführen — robust, parallel und nachvollziehbar.

## Status

🚧 **In Entwicklung** — aktuell wird das Grundgerüst aufgebaut.

## Features (geplant)

- 📦 Bulk-Operationen über beliebig viele Git-Repositories
- ⚙️ Konfigurationsdateien in **YAML, JSON, JS oder TS**
- 🔁 Robustes Retry-Verhalten mit konfigurierbarem Backoff
- ⏱️ Timeouts pro Git-Befehl
- 🚦 Konfigurierbare Parallelität (Concurrency-Limit)
- 🧪 Dry-Run-Modus für sicheres Testen
- 📊 Strukturiertes Logging und Exit-Code-Report pro Repository

## Voraussetzungen

- Node.js **>= 20.0.0**
- Git auf dem System installiert (`git --version`)

## Installation (Entwicklung)

```bash
git clone <repo-url>
cd GitBulk
npm install
npm run build
```

## Entwicklungs-Skripte

| Skript               | Beschreibung                                     |
| -------------------- | ------------------------------------------------ |
| `npm run dev`        | CLI direkt aus TypeScript ausführen (via tsx)    |
| `npm run build`      | TypeScript nach `dist/` kompilieren              |
| `npm run typecheck`  | Typen prüfen ohne Output                         |
| `npm run lint`       | ESLint über `src/` laufen lassen                 |
| `npm run format`     | Prettier-Formatierung anwenden                   |
| `npm test`           | Tests via Node Test Runner ausführen             |

## Projektstruktur

```
src/
├── cli/        CLI-Einstiegspunkt, Argument-Parsing
├── config/     Config-Loader (YAML/JSON/JS/TS), Schema-Validierung
├── core/       Bulk-Runner, Orchestrierung, Result-Types
├── git/        Git-Befehls-Executor, einzelne Git-Operationen
└── utils/      Logger, Retry-Logik, Timeout-Wrapper
```

## Lizenz

Apache License 2.0 — siehe [LICENSE](./LICENSE).
