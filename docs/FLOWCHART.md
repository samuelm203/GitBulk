# GitBulk Flowchart — Implementierungs-Referenz

Diese Datei dokumentiert die im Flowchart (`Flowchart/GitBulk_FlowChart.drawio`)
beschriebene Logik in Textform, damit der Code 1:1 abgebildet werden kann.

## Vier Phasen

Das Flowchart ist in vier farblich getrennte Phasen aufgeteilt:

1. **Input from User**     — Eingaben sammeln und in `$config` ablegen
2. **Preparation**         — Konfiguration einfrieren, Iteration starten
3. **Git & Code**          — Pro RU: Vorbereitung, Code-Change, Push (mit Retry)
4. **Pull Request (PR)**   — Pro RU: PR via API erstellen, Cleanup

> **Begriff:** "RU" = Repository Unit, also ein einzelnes Repository in der
> Bulk-Liste.

---

## Phase 1 — Input from User

Sequentielle interaktive Abfrage. Bei jeder Eingabe gilt:
Bei ungültiger Eingabe → Fehlermeldung ausgeben → erneut fragen.

1. **`input_rus`**       — Liste der RUs (komma-separiert)
   - Validierung: nicht leer → sonst `Error: RU list is missing`
   - `clean input_rus` → Whitespace/etc. entfernen
   - Speichern als Array in `$config.rus`
   - Wenn `config.rus` leer → erneut fragen

2. **`input_branch`**    — Branch-Name
   - Replace Special Characters
   - Validierung: gültiger Git-Branch-Name → sonst `Error: Invalid branch name`
   - Speichern in `$config.branch`

3. **`input_script`**    — Pfad zum Code-Change-Skript
   - Pfad validieren / Datei existiert → sonst `Error: File not found`
   - Speichern in `$config.script`

4. **`msg`**             — Commit-Message
   - Validierung: nicht leer → sonst `Error: Message is empty`
   - Speichern in `$config.commitMessage`

5. **`input_summary`**   — PR-Summary (Titel/Beschreibung)
   - Speichern in `$config.prSummary`

6. **`input_errorPrOn`** — "Wenn Code-Change fehlschlägt, trotzdem PR erstellen?" (Y/N)
   - Map: `Y → true`, `N → false` → sonst `Error: Only Y or N allowed`
   - Speichern in `$config.createPrOnError`

7. Bestätigungs-Loop: Config-Zusammenfassung anzeigen
   - Bei "N": `Restarting configuration...` → zurück zu Schritt 1
   - Bei "Y": → Phase 2

---

## Phase 2 — Preparation

- **Freeze all Config files in memory (read-only)** — Config ab hier immutable
- Print: `Config. was successfully loaded.`
- Einstieg in Iteration: **`More RUs in list?`**
  - **No**  → Ende
  - **Yes** → nächstes RU laden → Phase 3

---

## Phase 3 — Git & Code (pro RU)

### 3.1 Existenz-Check
- Wenn RU lokal **nicht gefunden**:
  Log `[RU] not found locally, moving to next RU` → zurück zu "More RUs in list?"

### 3.2 Branch lesen & Status prüfen
- `Read current branch` → in `[branch]` speichern (Wiederherstellung später)
- `git status --porcelain` ausführen
- **Output empty?**
  - **Yes** → `is_stashed = false`
  - **No**  → `git stash -u -m 'AUTO BACKUP'` → `is_stashed = true`

### 3.3 Master/Main aktualisieren
- `git fetch origin`
- `git checkout master`
- `git reset --hard origin/master`
- `git clean -fd`

### 3.4 Feature-Branch anlegen & Code-Change
- `git checkout -b [AKB Ticket] + [BranchName]`
- `[Code_Change] execute` (das benutzerdefinierte Skript)
- **Exit-Code == 0?**

### 3.5a Pfad: Exit-Code == 0 (Erfolg im Code-Change)
- **Diff vorhanden?** (`git status --porcelain` o. Ä.)
  - **No**  → Log `No Change after [Change_Code] / RU` → springe zu Phase 3.7 Cleanup
  - **Yes** → `git add .` → `git commit -m 'feat: ...'` (aus `$config.commitMessage`)
            → **Push-Counter = 0** → Push-Loop (Phase 3.6)
            → Bei Erfolg: `Status = create_PR`

### 3.5b Pfad: Exit-Code != 0 (Fehler im Code-Change)
- **Diff vorhanden?**
  - **No**  → Log `No diff after failed [Change_Code] / RU` → Phase 3.7 Cleanup
  - **Yes** → `git add .` → `git commit -m 'ERROR WHILE CODE CHANGE'`
            → **Push-Counter = 0** → Push-Loop (Phase 3.6)
            → Bei Erfolg: `Status = create_PR_with_Error`
            → Log: `Push successful with error in code, RU`

### 3.6 Push-Loop (Retry mit Backoff)
```
loop:
  git push origin --force-with-lease
  Push successful?
    Yes → weiter mit Status setzen
    No  → Counter < 3?
            Yes → Counter + 1 → Sleep (Backoff) → loop
            No  → Log 'Push Error after multiple Retries, RU'
                  → Phase 3.7 Cleanup
```

### 3.7 Cleanup (immer ausgeführt nach PR oder Skip)
- `git checkout [branch]`    (zurück zum ursprünglichen Branch)
- `git stash pop`            (nur wenn `is_stashed == true`)
- **Exit-Code == 0?**
  - **Yes** → weiter
  - **No**  → Log `Cleanup [RU] failed manual fix`

### 3.8 Übergang zu PR-Phase
- **Is PR_Status = create_PR?**
  - **No**  → `git branch -D [AKB Ticket] + [BranchName]` → zurück zu "More RUs?"
  - **Yes** → → Phase 4

---

## Phase 4 — Pull Request

### 4.1 PR-Status-Check
- **Is PR_Status = Empty?**
  - **Yes** → Log `No PR [dev] RU` → zurück zu "More RUs?"
  - **No**  → weiter

### 4.2 PR via API erstellen
- `API: Create a PR for this RU` (mit `$config.prSummary` als Titel/Body)
- **API Response 200?**
  - **Yes** → Log `PR successful, RU` → zurück zu "More RUs?"
  - **No**  → Log `PR failed [API] RU / API Response` → zurück zu "More RUs?"

### Sonderfall: `Status = create_PR_with_Error`
- Nur dann PR erstellen, wenn `$config.createPrOnError == true`
- Andernfalls: Log `PR Skip [Sys.], no Diff, Step / RU`

---

## Wichtige Variablen / State

| Variable               | Scope    | Beschreibung                                |
| ---------------------- | -------- | ------------------------------------------- |
| `$config.rus`          | global   | Array der Repository-Units                  |
| `$config.branch`       | global   | Branch-Name-Schema (z. B. `feature/xyz`)    |
| `$config.script`       | global   | Pfad zum Code-Change-Skript                 |
| `$config.commitMessage`| global   | Commit-Message                              |
| `$config.prSummary`    | global   | PR-Titel/Beschreibung                       |
| `$config.createPrOnError` | global| Auch bei fehlgeschlagenem Code-Change PR?  |
| `[branch]`             | per-RU   | Ursprünglicher Branch (für Cleanup)         |
| `is_stashed`           | per-RU   | Wurde gestasht? (für Cleanup-Pop)           |
| `Push-Counter`         | per-RU   | Retry-Zähler für Push (max 3)               |
| `PR_Status`            | per-RU   | `empty` / `create_PR` / `create_PR_with_Error` |

---

## Mapping auf Module

| Phase                | Modul-Datei                          |
| -------------------- | ------------------------------------ |
| Input from User      | `src/cli/prompts.ts`                 |
| Config-Freeze + Loop | `src/core/runner.ts`                 |
| Git-Operationen      | `src/git/operations.ts`              |
| Git-Executor (Wrapper)| `src/git/executor.ts`               |
| Push-Retry-Loop      | `src/utils/retry.ts` + `operations` |
| PR-API-Call          | `src/git/pr.ts` (neu)                |
| Logging              | `src/utils/logger.ts`                |
