/**
 * Plattform-Adapter-Interface für Pull Requests.
 *
 * Phase 4 des Flowcharts ist plattform-agnostisch dargestellt
 * (`API: Create a PR for this RU`). Damit wir später ohne Mehraufwand
 * verschiedene Plattformen unterstützen können (Bitbucket Cloud,
 * Bitbucket Server, Azure DevOps, …), trennen wir das Interface
 * von der konkreten Implementierung.
 *
 * Jede neue Plattform implementiert `PullRequestAdapter` und wird in
 * `createPrAdapter()` registriert.
 */

import type { GitBulkConfig } from '../config/schema.js';

/**
 * Eingabeparameter für einen PR-Create-Aufruf.
 *
 * Bewusst plattform-agnostisch gehalten: Felder wie "title", "body",
 * "source.branch" sind universell. Plattform-spezifische Details
 * (Bitbucket: workspace/repo_slug, Azure: organization/project) kommen
 * aus der jeweiligen Sub-Config (`config.bitbucket`, `config.azureDevOps`).
 */
export interface CreatePrInput {
  /** RU-Name (Repository-Slug auf der Plattform) */
  ru: string;
  /**
   * Optionaler Workspace-Override für genau diese RU (Bitbucket-Workspace bzw.
   * GitHub-Owner). Wenn gesetzt, hat er Vorrang vor dem globalen Wert aus der
   * Sub-Config — so können RUs aus mehreren Workspaces in einem Lauf landen.
   */
  workspace?: string;
  /** Source-Branch (Feature-Branch, vorher gepusht) */
  sourceBranch: string;
  /** Ziel-Branch (z. B. `master`, `main`, `develop`) */
  targetBranch: string;
  /** PR-Titel */
  title: string;
  /** PR-Beschreibung (Markdown, plattform-spezifisch optional) */
  description?: string;
  /**
   * Liste von Reviewer-Identifiern.
   * Format ist plattform-spezifisch: Bitbucket erwartet UUIDs in der Form
   * `{...}` oder Account-IDs; Azure DevOps erwartet User-IDs/Email-Adressen.
   */
  reviewers: readonly string[];
}

/**
 * Ergebnis eines PR-Create-Aufrufs.
 *
 * `Result`-Style (kein Throw): der Aufrufer entscheidet, wie mit Fehlern
 * umgegangen wird (Log + weiter mit nächstem RU, oder Abbruch).
 */
export type CreatePrResult =
  | {
      ok: true;
      /** Plattform-spezifische PR-ID (Nummer oder String) */
      id: string | number;
      /** Direkt-Link zum PR im Web-UI */
      url: string;
      /** HTTP-Status der API-Antwort (z. B. 201) */
      statusCode: number;
      /**
       * `true`, wenn KEIN neuer PR erstellt wurde, sondern ein bereits
       * offener PR zum selben Source-Branch gefunden wurde (Re-Run-Fall).
       * Steuert die Anzeige „PR updated" statt „PR created".
       */
      updated?: boolean;
    }
  | {
      ok: false;
      /** HTTP-Status der API-Antwort (z. B. 401, 422, 500) oder 0 bei Netzwerkfehler */
      statusCode: number;
      /** Menschen-lesbare Fehlermeldung */
      error: string;
      /** Roh-Body der API-Antwort für Debugging */
      rawBody?: string;
    };

/**
 * Eingabe für einen reinen **Status-Lookup** (read-only, `gitbulk status`).
 *
 * Anders als `CreatePrInput` braucht es keinen Titel/Reviewer — nur, in welchem
 * Repo nach welchem Source-Branch gesucht wird.
 */
export interface PrLookupInput {
  /** RU-Name (Repository-Slug auf der Plattform). */
  ru: string;
  /** Optionaler Per-RU-Workspace/Owner-Override (wie bei `CreatePrInput`). */
  workspace?: string;
  /** Source-/Feature-Branch, nach dessen PR gesucht wird. */
  sourceBranch: string;
}

/**
 * Zustand eines Pull Requests aus Sicht der Status-Abfrage.
 *
 *   - `open`     → offener PR existiert
 *   - `merged`   → PR wurde gemerged
 *   - `declined` → PR wurde abgelehnt/geschlossen (Bitbucket DECLINED/SUPERSEDED,
 *                  GitHub `closed` ohne Merge)
 *   - `none`     → kein PR für diesen Source-Branch gefunden
 */
export type PrState = 'open' | 'merged' | 'declined' | 'none';

/**
 * Aggregierter CI-/Build-Zustand des PR-Source-Commits.
 *
 *   - `passed`  → mindestens ein Status, alle erfolgreich
 *   - `failed`  → mindestens ein fehlgeschlagener Status
 *   - `running` → kein Fehler, aber mindestens einer läuft noch
 *   - `none`    → keine CI-Stati gemeldet (oder nicht ermittelbar)
 */
export type CiState = 'passed' | 'failed' | 'running' | 'none';

/** Approval-Zähler eines PR. */
export interface PrApprovals {
  /** Anzahl bereits erteilter Approvals. */
  approved: number;
  /**
   * Anzahl erwarteter Reviewer, falls die Plattform das hergibt
   * (Bitbucket: Reviewer-Liste). GitHub liefert keine harte Vorgabe → bleibt offen.
   */
  required?: number;
}

/**
 * Ergebnis eines PR-Status-Lookups. Result-Style: wirft NIE — ein API-/Netzwerk-
 * fehler wird über `error` gemeldet (und `state` ist dann `none`).
 */
export interface PrStatusInfo {
  /** Zustand des gefundenen PR (oder `none`). */
  state: PrState;
  /** PR-ID/-Nummer, falls einer existiert. */
  id?: string | number;
  /** Direkt-Link zum PR im Web-UI. */
  url?: string;
  /** Approvals (best-effort; fehlt, wenn nicht ermittelbar). */
  approvals?: PrApprovals;
  /** CI-/Build-Rollup (best-effort; fehlt, wenn nicht ermittelbar). */
  ci?: CiState;
  /** Bei einem API-/Netzwerkfehler: menschen-lesbare Meldung. */
  error?: string;
}

/**
 * Plattform-Adapter-Interface. Jede unterstützte Plattform (Bitbucket,
 * Azure DevOps, …) implementiert dieses Interface.
 */
export interface PullRequestAdapter {
  /**
   * Name der Plattform für Logging. Z. B. `'bitbucket'`.
   */
  readonly platformName: string;

  /**
   * Erstellt einen Pull Request.
   *
   * @param input - Plattform-agnostische PR-Daten
   * @returns Erfolgs- oder Fehler-Result (wirft NIE)
   */
  createPullRequest(input: CreatePrInput): Promise<CreatePrResult>;

  /**
   * Schlägt den PR-Status für einen Source-Branch nach (read-only, `gitbulk
   * status`). **Optional** — Plattformen ohne Implementierung (z. B. Azure)
   * lassen die Methode weg; der Aufrufer meldet das dann sauber.
   *
   * @param input - Repo + Source-Branch
   * @returns Status-Info (wirft NIE)
   */
  getPullRequestStatus?(input: PrLookupInput): Promise<PrStatusInfo>;
}

/**
 * Fehler-Klasse für Konfigurationsprobleme beim Adapter-Bau
 * (z. B. fehlende Env-Variable für den Token).
 */
export class PrAdapterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PrAdapterError';
  }
}

/**
 * Factory: erstellt den passenden Adapter basierend auf `config.prPlatform`.
 *
 * Tokens werden NIE aus der Config-Datei gelesen — immer aus Env-Variablen,
 * damit sie nicht versehentlich eingecheckt werden:
 *
 *   - Bitbucket:     GITBULK_BITBUCKET_TOKEN
 *   - GitHub:        GITBULK_GITHUB_TOKEN
 *   - GitLab:        GITBULK_GITLAB_TOKEN
 *   - Azure DevOps:  GITBULK_AZURE_DEVOPS_TOKEN
 *
 * @param config - Validierte GitBulk-Config (gefreezed)
 * @returns Bereit zur Nutzung
 * @throws {PrAdapterError} bei fehlendem Token oder unsupported platform
 */
export async function createPrAdapter(config: GitBulkConfig): Promise<PullRequestAdapter> {
  switch (config.prPlatform) {
    case 'bitbucket': {
      if (!config.bitbucket) {
        // Schema sollte das verhindern, aber defensiver Check schadet nicht.
        throw new PrAdapterError('prPlatform=bitbucket but no bitbucket config present');
      }
      const token = process.env.GITBULK_BITBUCKET_TOKEN;
      if (!token || token.trim().length === 0) {
        throw new PrAdapterError(
          'Environment variable GITBULK_BITBUCKET_TOKEN is required for Bitbucket PR creation',
        );
      }
      // Lazy-Import, damit eine fehlerhafte Bitbucket-Lib nicht ganz GitBulk killt.
      const { BitbucketPrAdapter } = await import('./pr-bitbucket.js');
      return new BitbucketPrAdapter(config.bitbucket, token);
    }
    case 'github': {
      if (!config.github) {
        throw new PrAdapterError('prPlatform=github but no github config present');
      }
      const token = process.env.GITBULK_GITHUB_TOKEN;
      if (!token || token.trim().length === 0) {
        throw new PrAdapterError(
          'Environment variable GITBULK_GITHUB_TOKEN is required for GitHub PR creation',
        );
      }
      const { GitHubPrAdapter } = await import('./pr-github.js');
      return new GitHubPrAdapter(config.github, token);
    }
    case 'gitlab': {
      if (!config.gitlab) {
        throw new PrAdapterError('prPlatform=gitlab but no gitlab config present');
      }
      const token = process.env.GITBULK_GITLAB_TOKEN;
      if (!token || token.trim().length === 0) {
        throw new PrAdapterError(
          'Environment variable GITBULK_GITLAB_TOKEN is required for GitLab MR creation',
        );
      }
      const { GitLabPrAdapter } = await import('./pr-gitlab.js');
      return new GitLabPrAdapter(config.gitlab, token);
    }
    case 'azure-devops': {
      if (!config.azureDevOps) {
        throw new PrAdapterError('prPlatform=azure-devops but no azureDevOps config present');
      }
      const token = process.env.GITBULK_AZURE_DEVOPS_TOKEN;
      if (!token || token.trim().length === 0) {
        throw new PrAdapterError(
          'Environment variable GITBULK_AZURE_DEVOPS_TOKEN is required for Azure DevOps PR creation',
        );
      }
      const { AzureDevOpsPrAdapter } = await import('./pr-azure.js');
      return new AzureDevOpsPrAdapter(config.azureDevOps, token);
    }
    default: {
      // TypeScript-Exhaustiveness-Check
      const _exhaustive: never = config.prPlatform;
      throw new PrAdapterError(`Unsupported PR platform: ${String(_exhaustive)}`);
    }
  }
}
