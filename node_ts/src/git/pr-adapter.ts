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
    case 'azure-devops': {
      // Platzhalter — Implementierung folgt nach Bitbucket.
      throw new PrAdapterError(
        'Azure DevOps adapter is not yet implemented. Use prPlatform: "bitbucket" for now.',
      );
    }
    default: {
      // TypeScript-Exhaustiveness-Check
      const _exhaustive: never = config.prPlatform;
      throw new PrAdapterError(`Unsupported PR platform: ${String(_exhaustive)}`);
    }
  }
}
