/**
 * GitHub-Adapter für Pull Requests.
 *
 * Unterstützt GitHub.com und GitHub Enterprise (via `apiBaseUrl`, z. B.
 * `https://ghe.example.com/api/v3`).
 *
 * Authentifizierung: Bearer-Token aus `GITBULK_GITHUB_TOKEN`
 * (Personal Access Token oder GitHub-App-/Fine-grained-Token).
 *
 * Sicherheit: Tokens werden NIE geloggt — nur eine kurze Vorschau für Debug.
 */

import type { GitHubConfig } from '../config/schema.js';
import type { CreatePrInput, CreatePrResult, PullRequestAdapter } from './pr-adapter.js';
import { getDefaultLogger, type Logger } from '../utils/logger.js';

/** Default-API-Basis für GitHub.com. */
const DEFAULT_API_BASE = 'https://api.github.com';

/** Token-Vorschau für Debug-Logs. Niemals den vollen Token loggen. */
function tokenPreview(token: string): string {
  if (token.length <= 4) return '****';
  return `${token.slice(0, 4)}…(${token.length} chars)`;
}

/**
 * GitHub-Adapter-Implementierung.
 */
export class GitHubPrAdapter implements PullRequestAdapter {
  public readonly platformName = 'github';

  private readonly apiBase: string;
  private readonly token: string;
  private readonly logger: Logger;

  /**
   * @param config - GitHub-spezifische Konfiguration
   * @param token  - Access Token aus GITBULK_GITHUB_TOKEN
   * @param logger - Optionaler Logger
   */
  constructor(
    private readonly config: GitHubConfig,
    token: string,
    logger?: Logger,
  ) {
    this.apiBase = (config.apiBaseUrl ?? DEFAULT_API_BASE).replace(/\/+$/, '');
    this.token = token;
    this.logger = logger ?? getDefaultLogger();
    this.logger.debug(`GitHub adapter ready (token=${tokenPreview(token)}, base=${this.apiBase})`);
  }

  /** Gemeinsame Header für alle GitHub-API-Calls. */
  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      'User-Agent': 'gitbulk',
    };
  }

  /**
   * Erstellt einen Pull Request.
   *
   * POST {apiBase}/repos/{owner}/{ru}/pulls
   * Body: { title, head, base, body }
   */
  public async createPullRequest(input: CreatePrInput): Promise<CreatePrResult> {
    const url = `${this.apiBase}/repos/${encodeURIComponent(this.config.owner)}/${encodeURIComponent(input.ru)}/pulls`;
    const body: Record<string, unknown> = {
      title: input.title,
      head: input.sourceBranch,
      base: input.targetBranch,
    };
    if (input.description !== undefined && input.description.length > 0) {
      body.body = input.description;
    }

    this.logger.debug(`POST ${url} (head=${input.sourceBranch} → base=${input.targetBranch})`);

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body),
      });
    } catch (err) {
      return { ok: false, statusCode: 0, error: `network error: ${(err as Error).message}` };
    }

    const rawBody = await response.text();
    if (response.status !== 201 && response.status !== 200) {
      return this.parseFailure(response.status, rawBody);
    }

    const success = this.parseSuccess(response.status, rawBody, input);

    // Reviewer best-effort anfordern — ein Fehler hier macht den PR NICHT ungültig.
    if (success.ok && input.reviewers.length > 0 && typeof success.id === 'number') {
      await this.requestReviewers(input.ru, success.id, input.reviewers);
    }

    return success;
  }

  /** Extrahiert PR-Nummer und URL aus der Erfolgs-Antwort. */
  private parseSuccess(statusCode: number, rawBody: string, input: CreatePrInput): CreatePrResult {
    try {
      const data = JSON.parse(rawBody) as { number?: number; html_url?: string };
      const id = data.number ?? 'unknown';
      const url =
        data.html_url ?? `https://github.com/${this.config.owner}/${input.ru}/pull/${String(id)}`;
      return { ok: true, id, url, statusCode };
    } catch {
      return { ok: true, id: 'unknown', url: '', statusCode };
    }
  }

  /** Wandelt eine Fehler-Antwort in ein Result mit aussagekräftiger Meldung. */
  private parseFailure(statusCode: number, rawBody: string): CreatePrResult {
    let errorMessage = `HTTP ${statusCode}`;
    try {
      const data = JSON.parse(rawBody) as { message?: string; errors?: Array<{ message?: string }> };
      if (data.message) {
        errorMessage = `HTTP ${statusCode}: ${data.message}`;
        const detail = data.errors?.map((e) => e.message).filter(Boolean).join('; ');
        if (detail) errorMessage += ` (${detail})`;
      }
    } catch {
      const snippet = rawBody.slice(0, 200).replace(/\s+/g, ' ').trim();
      if (snippet.length > 0) errorMessage = `HTTP ${statusCode}: ${snippet}`;
    }
    return { ok: false, statusCode, error: errorMessage, rawBody };
  }

  /**
   * Fordert Reviewer für einen erstellten PR an (best-effort).
   * Fehler werden nur geloggt, nicht propagiert — der PR existiert bereits.
   */
  private async requestReviewers(ru: string, prNumber: number, reviewers: readonly string[]): Promise<void> {
    const url = `${this.apiBase}/repos/${encodeURIComponent(this.config.owner)}/${encodeURIComponent(ru)}/pulls/${prNumber}/requested_reviewers`;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ reviewers }),
      });
      if (res.status >= 300) {
        this.logger.warn(`Failed to request reviewers for PR #${prNumber} (HTTP ${res.status})`);
      }
    } catch (err) {
      this.logger.warn(`Failed to request reviewers for PR #${prNumber}: ${(err as Error).message}`);
    }
  }
}
