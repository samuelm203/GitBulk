/**
 * Phase 3 des Flowcharts ("Git & Code") — pro RU.
 *
 * Diese Datei orchestriert die atomaren Operations aus `operations.ts`
 * zu dem im Flowchart gezeichneten Ablauf. Die Reihenfolge der Schritte
 * spiegelt das Flowchart 1:1 wider, damit der Code als ausführbare
 * Dokumentation lesbar bleibt.
 *
 * Aufrufer: `core/runner.ts` (Phase 2 Loop).
 * Output: `Phase3Result` mit `prStatus`, der Phase 4 steuert.
 */

import { join, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';

import {
  isGitRepository,
  cloneRepo,
  readCurrentBranch,
  hasUncommittedChanges,
  hasMergeConflicts,
  stashAutoBackup,
  fetchOrigin,
  checkoutSourceBranch,
  resetHardToOrigin,
  cleanWorkingTree,
  buildFeatureBranchName,
  buildCommitMessage,
  createFeatureBranch,
  executeCodeChange,
  stageAll,
  commit,
  pushFeatureBranch,
  checkoutBranch,
  stashPop,
  deleteLocalBranch,
  type BaseGitOptions,
} from './operations.js';
import type { GitBulkConfig } from '../config/schema.js';
import type { Logger } from '../utils/logger.js';
import { getDefaultLogger } from '../utils/logger.js';
// Seiteneffekt-Import registriert alle Operationen; `getOperation` löst sie
// zur Laufzeit auf.
import { getOperation, type OperationContext } from '../operations/index.js';

/**
 * PR-Status (Flowchart-Variable `PR_Status`).
 * Steuert in Phase 4, ob und wie der PR angelegt wird.
 */
export type PrStatus = 'empty' | 'create_PR' | 'create_PR_with_Error';

/**
 * Ergebnis der Phase-3-Verarbeitung für eine RU.
 */
export interface Phase3Result {
  /** Name der RU */
  ru: string;
  /** Wurde Phase 3 überhaupt ausgeführt? (false bei nicht-gefundenem Repo) */
  processed: boolean;
  /** Welcher PR-Status soll an Phase 4 weitergegeben werden? */
  prStatus: PrStatus;
  /** Voll-qualifizierter Feature-Branch-Name (`<ticket>-<branch>`) */
  featureBranch: string;
  /** Liste der Logs/Status-Meldungen aus dem Flowchart */
  notes: string[];
  /** Hat der Cleanup-Schritt funktioniert? */
  cleanupOk: boolean;
  /** Insgesamt aufgetretener fataler Fehler (Repo wird ab da übersprungen) */
  fatalError?: string;
}

/**
 * Baut den vollen Repo-Pfad aus Workspace-Dir und RU-Namen.
 * Tilde-Expansion (~) ist hier nicht im Schema vorgesehen — kommt aus dem CWD/ENV.
 */
/** Expandiert ein führendes `~` / `~/` zum Home-Verzeichnis des Nutzers. */
function expandTilde(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return join(homedir(), p.slice(2));
  return p;
}

function resolveRepoPath(workspaceDir: string | undefined, ru: string): string {
  const expandedRu = expandTilde(ru);
  if (isAbsolute(expandedRu)) return expandedRu;
  const base = workspaceDir === undefined ? process.cwd() : expandTilde(workspaceDir);
  return join(base, expandedRu);
}

/**
 * Führt Phase 3 für eine einzelne RU durch.
 *
 * Folgt strikt dem Flowchart-Ablauf:
 *   3.1 Existenz-Check  → bei Fehlen: ggf. clonen oder skippen
 *   3.2 Branch & Status → ggf. stash
 *   3.3 Source-Branch aktualisieren
 *   3.4 Feature-Branch + Code-Change
 *   3.5 Diff-Check + Stage + Commit
 *   3.6 Push-Loop mit Retry
 *   3.7 Cleanup (Checkout zurück + Stash pop)
 *   3.8 Lokalen Branch löschen, wenn kein PR
 *
 * @returns `Phase3Result` mit `prStatus` für Phase 4
 */
export async function runPhase3(ru: string, config: GitBulkConfig): Promise<Phase3Result> {
  const logger = getDefaultLogger().withRu(ru);
  const repoPath = resolveRepoPath(config.workspaceDir, ru);
  const featureBranch = buildFeatureBranchName(config.ticket, config.branch);

  const result: Phase3Result = {
    ru,
    processed: false,
    prStatus: 'empty',
    featureBranch,
    notes: [],
    cleanupOk: true,
  };

  // ── 3.1 Existenz-Check ─────────────────────────────────────────
  if (!isGitRepository(repoPath)) {
    if (config.cloneIfMissing && config.cloneBaseUrl !== undefined) {
      logger.info(`Repository not found locally, cloning from ${config.cloneBaseUrl}`);
      const baseForClone: BaseGitOptions = {
        cwd: process.cwd(),
        timeoutMs: config.commandTimeoutMs,
        dryRun: config.dryRun,
        skipHooks: config.skipHooks,
        logger,
      };
      try {
        // URL-Bau: cloneBaseUrl + RU-Name (typisch: https://bitbucket.org/ws/<ru>.git)
        const remoteUrl = `${config.cloneBaseUrl.replace(/\/+$/, '')}/${ru}.git`;
        await cloneRepo(remoteUrl, repoPath, baseForClone);
      } catch (err) {
        const msg = `clone failed: ${(err as Error).message}`;
        logger.warn(msg);
        result.notes.push(msg);
        result.fatalError = msg;
        return result;
      }
    } else {
      // Genauere Diagnose: existiert das Verzeichnis (aber ohne `.git`) oder
      // fehlt es ganz? Die bisherige "not found"-Meldung war irreführend, wenn
      // der Ordner da war, aber kein Git-Repo ist.
      const msg = existsSync(repoPath)
        ? `[${ru}] exists but is not a git repository (no .git), moving to next RU`
        : `[${ru}] not found locally, moving to next RU`;
      logger.warn(msg);
      result.notes.push(msg);
      return result;
    }
  }

  // Ab hier wird Phase 3 echt durchlaufen.
  result.processed = true;

  // BaseGitOptions für alle Operationen im RU-Pfad
  const base: BaseGitOptions = {
    cwd: repoPath,
    timeoutMs: config.commandTimeoutMs,
    dryRun: config.dryRun,
    skipHooks: config.skipHooks,
    logger,
  };

  // ── 3.2 Branch lesen & Status prüfen ───────────────────────────
  let originalBranch: string;
  try {
    originalBranch = await readCurrentBranch(base);
  } catch (err) {
    const msg = `Could not read current branch: ${(err as Error).message}`;
    logger.error(msg);
    result.fatalError = msg;
    return result;
  }
  logger.debug(`original branch: ${originalBranch}`);

  // Ungelöste Merge-Konflikte: `git stash` scheitert hier ("could not write
  // index"). Statt den ganzen Lauf-RU fatal abzubrechen, überspringen wir das
  // Repo sauber mit einer Warnung (wie beim "not found locally"-Pfad).
  try {
    if (await hasMergeConflicts(base)) {
      const msg = `[${ru}] has unresolved merge conflicts, skipping (resolve them manually first)`;
      logger.warn(msg);
      result.notes.push(msg);
      result.processed = false;
      return result;
    }
  } catch (err) {
    const msg = `Could not check for merge conflicts: ${(err as Error).message}`;
    logger.error(msg);
    result.fatalError = msg;
    return result;
  }

  let isStashed = false;
  try {
    if (await hasUncommittedChanges(base)) {
      logger.info('Working tree dirty, creating AUTO BACKUP stash');
      await stashAutoBackup(base);
      isStashed = true;
    }
  } catch (err) {
    const msg = `Could not check / stash working tree: ${(err as Error).message}`;
    logger.error(msg);
    result.fatalError = msg;
    return result;
  }

  // Helper für Cleanup ab dem Moment, wo wir den Source-Branch betreten könnten.
  // Sammelt Fehler in result.cleanupOk, damit die nachfolgende Logik trotzdem weiterläuft.
  const performCleanup = async (): Promise<void> => {
    try {
      // Im Dry-Run wurden add/commit nicht ausgeführt, aber das Code-Change-Skript
      // hat echte Datei-Änderungen hinterlassen. Bevor wir zurück auf den
      // Originalbranch wechseln, müssen wir den Working Tree säubern — sonst
      // schlägt der Checkout fehl oder verschleppt Änderungen.
      if (config.dryRun) {
        // Echte (nicht-dry-run) Reset+Clean, damit Skript-Spuren verschwinden.
        const realBase: BaseGitOptions = { ...base, dryRun: false };
        await resetHardToOrigin(config.sourceBranch, realBase);
        await cleanWorkingTree(realBase);
      }

      const co = await checkoutBranch(originalBranch, base);
      if (co.exitCode !== 0) {
        const msg = `Cleanup [${ru}] failed manual fix (checkout: ${co.stderr.trim()})`;
        logger.warn(msg);
        result.notes.push(msg);
        result.cleanupOk = false;
        return;
      }
      if (isStashed) {
        const pop = await stashPop(base);
        if (pop.exitCode !== 0) {
          const msg = `Cleanup [${ru}] failed manual fix (stash pop: ${pop.stderr.trim()})`;
          logger.warn(msg);
          result.notes.push(msg);
          result.cleanupOk = false;
        }
      }
    } catch (err) {
      const msg = `Cleanup [${ru}] failed manual fix: ${(err as Error).message}`;
      logger.warn(msg);
      result.notes.push(msg);
      result.cleanupOk = false;
    }
  };

  // ── 3.3 Source-Branch aktualisieren ────────────────────────────
  try {
    await fetchOrigin(base);
    await checkoutSourceBranch(config.sourceBranch, base);
    await resetHardToOrigin(config.sourceBranch, base);
    await cleanWorkingTree(base);
  } catch (err) {
    const msg = `Could not update source branch ${config.sourceBranch}: ${(err as Error).message}`;
    logger.error(msg);
    result.fatalError = msg;
    // Cleanup versuchen, auch wenn wir Source-Branch nicht geupdated haben
    await performCleanup();
    return result;
  }

  // ── 3.4 Feature-Branch anlegen ─────────────────────────────────
  const branchCreate = await createFeatureBranch(featureBranch, base);
  if (branchCreate.exitCode !== 0) {
    const msg = `Could not create feature branch ${featureBranch}: ${branchCreate.stderr.trim()}`;
    logger.error(msg);
    result.fatalError = msg;
    await performCleanup();
    return result;
  }

  // ── 3.4 Code-Change ausführen (deklarative Operationen ODER Skript) ──
  // Beide Pfade münden in dasselbe `codeChangeOk`-Flag, sodass der restliche
  // Ablauf (Diff-Check, commit, push, PR-Status) unverändert bleibt.
  let codeChangeOk: boolean;
  if (config.operations && config.operations.length > 0) {
    const opCtx: OperationContext = {
      repoDir: repoPath,
      ru,
      ticket: config.ticket,
      branch: featureBranch,
      sourceBranch: config.sourceBranch,
    };
    const opsResult = await runOperations(config.operations, opCtx, logger);
    codeChangeOk = opsResult.ok;
    result.notes.push(...opsResult.notes);
    logger.debug(
      `operations result: ok=${opsResult.ok}, changedAny=${opsResult.changedAny}`,
    );
  } else if (config.script !== undefined) {
    let codeChange: { exitCode: number | null; stdout: string; stderr: string; timedOut: boolean };
    try {
      codeChange = await executeCodeChange(
        config.script,
        {
          ru,
          ticket: config.ticket,
          branch: featureBranch,
          sourceBranch: config.sourceBranch,
        },
        base,
      );
    } catch (err) {
      // Skript konnte nicht gestartet werden (z. B. Interpreter fehlt auf Windows).
      // Das ist ein fataler Fehler für diesen RU, darf aber den Bulk-Lauf nicht
      // crashen. Wir behandeln es wie einen fehlgeschlagenen Code-Change ohne Diff.
      const msg = `Code change script could not be executed: ${(err as Error).message}`;
      logger.error(msg);
      result.fatalError = msg;
      await performCleanup();
      await deleteLocalBranchSafe(featureBranch, base, result, logger);
      return result;
    }
    codeChangeOk = codeChange.exitCode === 0;
    logger.debug(`code change exit: ${codeChange.exitCode}, timedOut: ${codeChange.timedOut}`);
  } else {
    // Sollte durch die Schema-Validierung (genau eines von script/operations)
    // nie eintreten — defensiv als fataler Fehler behandeln.
    const msg = 'No code change defined (neither script nor operations)';
    logger.error(msg);
    result.fatalError = msg;
    await performCleanup();
    await deleteLocalBranchSafe(featureBranch, base, result, logger);
    return result;
  }

  // ── 3.5 Diff-Check ─────────────────────────────────────────────
  let hasDiff = false;
  try {
    hasDiff = await hasUncommittedChanges(base);
  } catch (err) {
    logger.warn(`could not check for diff: ${(err as Error).message}`);
  }

  if (!hasDiff) {
    // Beide Pfade (Code-Change OK oder nicht) enden hier ohne Commit/Push.
    const msg = codeChangeOk
      ? `No Change after [Change_Code] / ${ru}`
      : `No diff after failed [Change_Code] / ${ru}`;
    logger.info(msg);
    result.notes.push(msg);
    // PR_Status bleibt 'empty' → Cleanup → kein PR → Branch löschen
    await performCleanup();
    await deleteLocalBranchSafe(featureBranch, base, result, logger);
    return result;
  }

  // ── 3.5 Stage & Commit ─────────────────────────────────────────
  try {
    await stageAll(base);
  } catch (err) {
    const msg = `git add failed: ${(err as Error).message}`;
    logger.error(msg);
    result.fatalError = msg;
    await performCleanup();
    await deleteLocalBranchSafe(featureBranch, base, result, logger);
    return result;
  }

  // Bei fehlgeschlagenem Code-Change wird der Fehlschlag IN der Commit-Message
  // vermerkt — und die konfigurierte Message bleibt als Kontext erhalten (statt
  // sie zu verwerfen). So zeigt der Commit (und damit der PR, wenn
  // `createPrOnError` ihn erstellt) klar, dass die Änderung fehlschlug.
  const baseMessage = buildCommitMessage(config.ticket, config.commitMessage);
  const commitMessage = codeChangeOk
    ? baseMessage
    : `ERROR WHILE CODE CHANGE: ${baseMessage}`;
  const commitResult = await commit(commitMessage, base);
  if (commitResult.exitCode !== 0) {
    const msg = `git commit failed: ${commitResult.stderr.trim() || commitResult.stdout.trim()}`;
    logger.error(msg);
    result.fatalError = msg;
    await performCleanup();
    await deleteLocalBranchSafe(featureBranch, base, result, logger);
    return result;
  }

  // ── 3.6 Push mit Retry ─────────────────────────────────────────
  const pushResult = await pushFeatureBranch(featureBranch, base, config.retry);

  if (pushResult.ok) {
    // Push erfolgreich → Status setzen je nach Code-Change-Ergebnis.
    if (codeChangeOk) {
      result.prStatus = 'create_PR';
      const msg = `Push successful, ${ru}`;
      logger.info(msg);
      result.notes.push(msg);
    } else {
      result.prStatus = 'create_PR_with_Error';
      const msg = `Push successful with error in code, ${ru}`;
      logger.info(msg);
      result.notes.push(msg);
    }
  } else {
    const msg = pushResult.exhausted
      ? `Push Error after multiple Retries, ${ru}`
      : `Push permanently failed (${pushResult.error}), ${ru}`;
    logger.warn(msg);
    result.notes.push(msg);
    // PR_Status bleibt 'empty'
  }

  // ── 3.7 Cleanup ────────────────────────────────────────────────
  await performCleanup();

  // ── 3.8 Branch löschen, wenn kein PR ───────────────────────────
  if (result.prStatus === 'empty') {
    await deleteLocalBranchSafe(featureBranch, base, result, logger);
  }

  return result;
}

/**
 * Hilfsfunktion: löscht den Feature-Branch lokal, ohne dass Fehler die
 * Phase abbrechen (Cleanup-Phase ist best-effort).
 */
async function deleteLocalBranchSafe(
  featureBranch: string,
  base: BaseGitOptions,
  result: Phase3Result,
  logger: Logger,
): Promise<void> {
  const del = await deleteLocalBranch(featureBranch, base);
  if (del.exitCode !== 0) {
    const msg = `Could not delete local feature branch ${featureBranch}: ${del.stderr.trim()}`;
    logger.debug(msg);
    result.notes.push(msg);
  }
}

/**
 * Führt eine Kette deklarativer Operationen nacheinander im Repo aus.
 *
 * Aggregation (analog zur Exit-Code-/Diff-Logik des Skript-Pfads):
 *   - `ok: false`, sobald IRGENDEINE Operation `error` liefert oder wirft
 *     → entspricht Exit-Code != 0 ⇒ Commit-Message "ERROR WHILE CODE CHANGE".
 *   - `changedAny: true`, wenn IRGENDEINE Operation `changed: true` meldet
 *     (rein informativ — der echte Diff-Check in Phase 3.5 entscheidet ohnehin).
 *
 * Operationen sollen NUR Dateien ändern (kein git add/commit/push). Die
 * Parameter werden erneut gegen das registrierte Schema geparst, damit Defaults
 * (z. B. `pomPath`) angewendet werden — die Struktur wurde beim Laden bereits
 * validiert.
 */
async function runOperations(
  ops: ReadonlyArray<{ type: string }>,
  ctx: OperationContext,
  logger: Logger,
): Promise<{ ok: boolean; changedAny: boolean; notes: string[] }> {
  const notes: string[] = [];
  let changedAny = false;
  let hadError = false;

  for (const opConfig of ops) {
    const operation = getOperation(opConfig.type);
    if (!operation) {
      // Sollte durch die Schema-Validierung nie passieren — defensiv.
      const msg = `[op ${opConfig.type}] unknown operation type`;
      logger.error(msg);
      notes.push(msg);
      hadError = true;
      continue;
    }

    try {
      const params = operation.schema.parse(opConfig);
      const res = await operation.apply(params, ctx);
      if (res.changed) {
        changedAny = true;
      }
      if (res.error) {
        hadError = true;
        const msg = `[op ${opConfig.type}] ${res.error}`;
        logger.error(msg);
        notes.push(msg);
      } else {
        const msg = `[op ${opConfig.type}] ${res.message}`;
        logger.debug(msg);
        notes.push(msg);
      }
    } catch (err) {
      hadError = true;
      const msg = `[op ${opConfig.type}] threw: ${(err as Error).message}`;
      logger.error(msg);
      notes.push(msg);
    }
  }

  return { ok: !hadError, changedAny, notes };
}
