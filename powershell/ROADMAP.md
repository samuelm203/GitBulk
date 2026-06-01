# GitBulk — PowerShell-Port (Roadmap)

Eine **native PowerShell-Portierung** von GitBulk mit dem Ziel **voller Parität**
zur TypeScript/Node-Implementierung in [`../node_ts/`](../node_ts). Kein Node zur
Laufzeit nötig.

## Eckdaten

- **PowerShell 7.2+** (LTS), cross-platform (Windows / Linux / macOS).
- Modul **`GitBulk`** (`GitBulk.psd1` + `GitBulk.psm1`), Funktionen unter `src/`.
- Tests: **Pester v5** · Lint: **PSScriptAnalyzer** · YAML: **powershell-yaml**.
- CI: eigener `pwsh`-Job (× 3 OS) in `.github/workflows/ci.yml`.
- Konvention: jede Phase = eigener PR; nach jeder Phase Pester + Analyzer grün.
- Kommentare/Antworten auf Deutsch (wie im Gesamtprojekt).

## Phasen

| Phase | Inhalt | Kern-Deliverables |
|------|--------|-------------------|
| **0 – Gerüst** | Modul-Skelett, Pester/Analyzer, CI-Job, Konventionen | `GitBulk.psd1/.psm1`, `src/Public`, `tests/`, `build.ps1`, CI grün |
| **1 – Config** | Laden + Validierung (JSON nativ, YAML via powershell-yaml), `script` XOR `operations` | `Get-GitBulkConfig`, Validierung über PS-Klassen |
| **2 – Git-Executor** | `git`-Wrapper: Timeout, Output-Capture, Exit-Code, **Prozess-Tree-Kill** (Win `taskkill /T /F`; POSIX rekursiv über ParentProcessId) | `Invoke-Git` |
| **3 – Runner & Code-Change** | RU-Loop mit `ForEach-Object -Parallel -ThrottleLimit`, Interpreter-Wahl (`.ps1`/`.sh`/`.mjs`/`.ts`), Diff→commit/push, Retry/Backoff | `Invoke-GitBulkRun` |
| **4 – PR-Adapter** | `Invoke-RestMethod` für **Bitbucket** + **GitHub** (Tokens aus Env, Result-Style) | `New-BitbucketPullRequest`, `New-GitHubPullRequest`, Factory |
| **5 – CLI & Report** | `Invoke-GitBulk` / `gitbulk.ps1` mit `-Config`/`-DryRun`/`-Only`, Abschluss-Report | öffentliche CLI |
| **6 – Operationen & Generator** | Operations-Registry + 8 Operationen, `list-operations`, interaktiver `init` | Parität zur TS-Version |

### Phase 6 — Teilschritte

- **6a (✅):** Operations-Registry (`Register-/Get-GitBulkOperation`, `Get-GitBulkOperationList`,
  `Invoke-GitBulkOperation`) + Pfad-Sicherheit (`Resolve-InRepoPath`) + die vier
  **Datei-Operationen** (`add-file`, `replace-file`, `delete-file`, `regex-replace`)
  + Integration in `Invoke-GitBulkRu` (script XOR operations) + Config-Validierung
  (unbekannter Typ / fehlender Pflicht-Param → Exit 3).
- **6b (✅):** JSON-Helfer (`Json.ps1` — ordnungserhaltender Parser + eigener
  Serializer mit Indent-Beibehaltung) + `maven-add-dependency`, `npm-add-dependency`,
  `npm-update`, `json-patch`. Damit sind alle 8 Operationen portiert.
- **6c-1 (✅):** Parameter-Metadaten je Operation (`Params`: Name/Kind/Required/
  Default/Enum) + öffentliche `Get-GitBulkOperationInfo` und `Show-GitBulkOperationList`
  (`gitbulk.ps1 -ListOperations [-Json]`). Pflichtparameter werden aus `Params` abgeleitet.
- **6c-2:** interaktiver `init`-Generator (`gitbulk.ps1 -Init`).

## Technische Knackpunkte

- **Prozess-Tree-Kill auf POSIX:** PowerShell hat keine Prozessgruppen-Signale →
  Kindprozesse rekursiv über `Get-CimInstance Win32_Process` (Windows) bzw.
  `/proc`/`pgrep` (POSIX) ermitteln und beenden.
- **Concurrency-Fehlerisolation:** `ForEach-Object -Parallel` läuft in eigenen
  Runspaces — Funktionen/Module müssen dort neu geladen werden; Fehler pro RU
  isolieren (kein Abbruch der anderen RUs).
- **Validierung ohne Zod:** PS-Klassen + manuelle Parameter-Prüfung; Operationen
  bringen ihr eigenes Validierungs-Skriptblock mit.
- **Token-Handling:** wie in der TS-Version NUR aus Env-Variablen
  (`GITBULK_BITBUCKET_TOKEN`, `GITBULK_GITHUB_TOKEN`).

## Verhältnis zur Node-Version

Beide Implementierungen leben im selben Repo (`node_ts/` und `powershell/`) und
sollen sich funktional entsprechen (gleiche Config-Felder, gleiches Verhalten).
Die Node-Version bleibt die Referenz; Abweichungen werden hier dokumentiert.
