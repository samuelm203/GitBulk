/**
 * Zod-Schema für die GitBulk-Konfiguration.
 *
 * Das Schema deckt alle `$config.*`-Variablen aus dem Flowchart ab und
 * fügt zusätzliche optionale Felder hinzu, die im Datei-Modus sinnvoll sind
 * (z. B. `workspaceDir`, `cloneIfMissing`, PR-Plattform-Settings).
 *
 * Die TypeScript-Typen werden automatisch via `z.infer` abgeleitet —
 * eine einzige Source of Truth für Datei-Validierung und Typen.
 *
 * Wichtig: Die Validierungs-Regeln spiegeln exakt die Validatoren aus
 * `utils/validators.ts` wider, sodass Datei-Config und interaktive Eingabe
 * äquivalent sind.
 */

import { z } from 'zod';

import {
  validateRuList,
  validateBranchName,
  validateTicket,
  validateFilePath,
  validateMessage,
} from '../utils/validators.js';

/**
 * Helfer: Wandelt eine bestehende `ValidationResult`-Funktion in ein Zod-Refinement.
 * Damit nutzen wir DRY die exakt gleichen Validierungsregeln wie im Interaktiv-Modus.
 */
function asZodCheck<T>(
  validator: (input: T) => { ok: true; value: T } | { ok: false; error: string },
) {
  return (input: T, ctx: z.RefinementCtx): void => {
    const result = validator(input);
    if (!result.ok) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: result.error });
    }
  };
}

/**
 * Schema für die unterstützten PR-Plattformen.
 *
 * Aktuell implementiert: Bitbucket.
 * Vorbereitet (Adapter-Interface, Implementierung folgt): Azure DevOps.
 */
export const PrPlatformSchema = z.enum(['bitbucket', 'azure-devops']);
export type PrPlatform = z.infer<typeof PrPlatformSchema>;

/**
 * Bitbucket-spezifische PR-Konfiguration.
 *
 * Token wird *nicht* in der Datei erwartet — er wird via Env-Variable
 * (`GITBULK_BITBUCKET_TOKEN`) gelesen, damit Tokens nicht versehentlich
 * eingecheckt werden.
 */
export const BitbucketConfigSchema = z.object({
  /** Workspace-Slug (Bitbucket Cloud) oder Project-Key (Bitbucket Server) */
  workspace: z.string().min(1, 'Bitbucket workspace must not be empty'),
  /**
   * API-Variante: `'cloud'` (Standard, api.bitbucket.org) oder `'server'`
   * (selbst-gehosteter Bitbucket Server/Data Center). Bestimmt sowohl
   * den URL-Pfad als auch das Payload-Format.
   */
  apiVariant: z.enum(['cloud', 'server']).default('cloud'),
  /** Optionale API-Basis-URL (für Bitbucket Server oder Custom-Cloud-Proxies) */
  apiBaseUrl: z.string().url().optional(),
  /** Ziel-Branch für die PRs (z. B. `main` oder `master`) */
  targetBranch: z.string().min(1).default('master'),
  /** Optionale Reviewer-UUIDs / Usernames */
  reviewers: z.array(z.string().min(1)).default([]),
});
export type BitbucketConfig = z.infer<typeof BitbucketConfigSchema>;

/**
 * Azure DevOps PR-Konfiguration (Platzhalter — Adapter folgt später).
 */
export const AzureDevOpsConfigSchema = z.object({
  organization: z.string().min(1),
  project: z.string().min(1),
  apiBaseUrl: z.string().url().optional(),
  targetBranch: z.string().min(1).default('master'),
  reviewers: z.array(z.string().min(1)).default([]),
});
export type AzureDevOpsConfig = z.infer<typeof AzureDevOpsConfigSchema>;

/**
 * Retry-Verhalten beim `git push` (Flowchart: `Counter < 3` + `Sleep (Backoff)`).
 */
export const RetryConfigSchema = z.object({
  /** Maximale Anzahl Push-Versuche. Flowchart: 3 */
  maxAttempts: z.number().int().min(1).max(20).default(3),
  /** Backoff-Basis in Millisekunden (wird exponentiell multipliziert) */
  backoffMs: z.number().int().min(0).default(1000),
  /** Maximaler Backoff in ms (Cap für exponentielles Wachstum) */
  maxBackoffMs: z.number().int().min(0).default(30_000),
});
export type RetryConfig = z.infer<typeof RetryConfigSchema>;

/**
 * Hauptschema der GitBulk-Konfiguration.
 *
 * Felder mit Flowchart-Bezug sind im JSDoc gekennzeichnet.
 */
export const GitBulkConfigSchema = z
  .object({
    // ──────────────────────────────────────────────────────────────
    // Phase 1: "Input from User" — Pflichtfelder im Datei-Modus
    // ──────────────────────────────────────────────────────────────

    /** Flowchart: `$config.rus` — Liste der Repository-Units */
    rus: z
      .union([z.string(), z.array(z.string())])
      .transform((input) => {
        const result = validateRuList(input);
        if (!result.ok) {
          // Wird durch superRefine erneut geprüft; transform liefert hier
          // bereits den bereinigten Array, sodass Folgeprüfungen darauf laufen.
          return [];
        }
        return result.value;
      })
      .superRefine((value, ctx) => {
        if (value.length === 0) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'Error: RU list is missing',
          });
        }
      }),

    /** Flowchart: `$config.ticket` — z. B. `AKB-1234` (zusätzlicher Input-Schritt) */
    ticket: z.string().superRefine(asZodCheck(validateTicket)),

    /** Flowchart: `$config.branch` — Branch-Name (ohne Ticket-Präfix) */
    branch: z.string().superRefine(asZodCheck(validateBranchName)),

    /** Flowchart: `$config.script` — Pfad zum Code-Change-Skript */
    script: z.string().superRefine(asZodCheck(validateFilePath)),

    /** Flowchart: `$config.commitMessage` — Commit-Message */
    commitMessage: z.string().superRefine(asZodCheck(validateMessage)),

    /** Flowchart: `$config.prSummary` — PR-Titel/Beschreibung */
    prSummary: z.string().superRefine(asZodCheck(validateMessage)),

    /**
     * Flowchart: `$config.createPrOnError` — Pull Request auch dann erstellen,
     * wenn das Code-Change-Skript mit Exit-Code != 0 endete.
     */
    createPrOnError: z.boolean(),

    // ──────────────────────────────────────────────────────────────
    // Zusätzliche Felder im Datei-Modus (alle optional mit Defaults)
    // ──────────────────────────────────────────────────────────────

    /**
     * Wurzelverzeichnis, in dem die RU-Repositories erwartet werden.
     * Standard: aktuelles Arbeitsverzeichnis.
     *
     * NICHT IM FLOWCHART: Das Flowchart geht implizit davon aus, dass der
     * User im richtigen Verzeichnis steht. Für den Datei-Modus brauchen wir
     * eine explizite Angabe, sonst sind Bulk-Operationen über mehrere
     * Repos technisch nicht möglich.
     */
    workspaceDir: z.string().optional(),

    /**
     * Wenn `true`, klont GitBulk fehlende Repos automatisch (statt sie zu
     * überspringen). Flowchart: nicht vorgesehen — siehe Abweichungen.
     */
    cloneIfMissing: z.boolean().default(false),

    /**
     * Basis-URL für `git clone` (nur relevant wenn `cloneIfMissing: true`).
     * Beispiel: `https://bitbucket.org/my-workspace/`.
     */
    cloneBaseUrl: z.string().url().optional(),

    /**
     * Quell-Branch, auf den GitBulk vor dem Feature-Branch-Anlegen wechselt.
     * Flowchart: hardcoded `master`. Wir machen das konfigurierbar, weil
     * viele Repos heute `main` nutzen.
     */
    sourceBranch: z.string().min(1).default('master'),

    /** Retry-Konfiguration für `git push` */
    retry: RetryConfigSchema.default({}),

    /**
     * Anzahl der parallel verarbeitbaren RUs. Flowchart suggeriert sequentiell,
     * aber für Bulk macht parallele Verarbeitung Sinn (mit konservativem Default).
     */
    concurrency: z.number().int().min(1).max(50).default(1),

    /**
     * Timeout in Millisekunden pro Git-Befehl. Verhindert hängende Auth-Prompts.
     * Flowchart: nicht vorgesehen — defensive Erweiterung.
     */
    commandTimeoutMs: z.number().int().min(1000).default(120_000),

    /** Dry-Run-Modus: keine schreibenden Git-Operationen, kein API-Call */
    dryRun: z.boolean().default(false),

    /**
     * Wenn `true`, werden Git-Hooks (pre-commit, commit-msg, pre-push, …)
     * bei allen Git-Befehlen deaktiviert. Nützlich für Bulk-Operationen,
     * wo Linter/Formatter pro Repo das Verhalten verändern oder verzögern
     * würden.
     *
     * Implementiert via `git -c core.hooksPath=/dev/null` im Executor.
     * Flowchart: nicht vorgesehen — siehe Abweichungen-Liste.
     */
    skipHooks: z.boolean().default(false),

    // ──────────────────────────────────────────────────────────────
    // PR-Plattform
    // ──────────────────────────────────────────────────────────────

    /**
     * Welche PR-Plattform verwenden? Auswahl bestimmt, welches
     * Sub-Schema (`bitbucket` / `azureDevOps`) ausgewertet wird.
     */
    prPlatform: PrPlatformSchema,

    /** Bitbucket-spezifische Settings (Pflicht wenn prPlatform === 'bitbucket') */
    bitbucket: BitbucketConfigSchema.optional(),

    /** Azure-DevOps-spezifische Settings (Pflicht wenn prPlatform === 'azure-devops') */
    azureDevOps: AzureDevOpsConfigSchema.optional(),
  })
  // Cross-Field-Validierung: passende Sub-Config muss vorhanden sein.
  .superRefine((config, ctx) => {
    if (config.prPlatform === 'bitbucket' && !config.bitbucket) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['bitbucket'],
        message: 'bitbucket config is required when prPlatform is "bitbucket"',
      });
    }
    if (config.prPlatform === 'azure-devops' && !config.azureDevOps) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['azureDevOps'],
        message: 'azureDevOps config is required when prPlatform is "azure-devops"',
      });
    }
    if (config.cloneIfMissing && !config.cloneBaseUrl) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['cloneBaseUrl'],
        message: 'cloneBaseUrl is required when cloneIfMissing is true',
      });
    }
  });

/**
 * Vollständig validierte und mit Defaults aufgefüllte Konfiguration.
 * Wird im Runner als "frozen config" verwendet (Phase 2 des Flowcharts).
 */
export type GitBulkConfig = z.infer<typeof GitBulkConfigSchema>;

/**
 * Partielle Konfiguration für den Hybrid-Modus:
 * Datei liefert teilweise Werte, Rest wird interaktiv erfragt.
 *
 * Alle Felder sind optional, damit Teilkonfigurationen geladen werden können.
 */
export const PartialGitBulkConfigSchema = GitBulkConfigSchema.innerType().partial();
export type PartialGitBulkConfig = z.input<typeof PartialGitBulkConfigSchema>;
