/**
 * Bitbucket-Adapter für Pull Requests.
 *
 * Unterstützt sowohl **Bitbucket Cloud** (api.bitbucket.org/2.0) als auch
 * **Bitbucket Server / Data Center** (selbst-gehostet, REST API 1.0).
 *
 * Erkennung: wenn `apiBaseUrl` gesetzt ist UND nicht auf
 * `api.bitbucket.org` zeigt, wird der Server-API-Pfad genutzt
 * (`/rest/api/1.0/...`). Sonst Cloud-API.
 *
 * Authentifizierung: Bearer-Token aus `GITBULK_BITBUCKET_TOKEN`-Env-Variable.
 *   - Cloud: App-Password im HTTP-Basic-Format ODER OAuth Access Token via Bearer.
 *     Wir senden den Token als Bearer; das funktioniert mit Repository Access
 *     Tokens, Project Access Tokens, Workspace Access Tokens und OAuth-Tokens.
 *     App-Passwords erfordern Basic-Auth (`username:password`) und werden
 *     unten via `Basic <base64(user:pwd)>` unterstützt, wenn der Token-String
 *     ein `:` enthält.
 *   - Server: Personal Access Token via Bearer.
 *
 * Sicherheit: Tokens werden NIE in Logs ausgegeben — nur die ersten 4 Zeichen
 * für Debug-Zwecke.
 */

import { Buffer } from 'node:buffer';

import type { BitbucketConfig } from '../config/schema.js';
import type { CreatePrInput, CreatePrResult, PullRequestAdapter } from './pr-adapter.js';
import { getDefaultLogger, type Logger } from '../utils/logger.js';

/**
 * Baut den Authorization-Header.
 * Bitbucket Cloud nutzt nun Bearer-Token (ATATT...).
 */
function buildAuthHeader(token: string): string {
  // Wenn der Token ein `:` enthält, könnte es noch ein altes App-Passwort sein (user:pass).
  // Wir unterstützen das weiterhin über Basic-Auth, falls gewünscht.
  // Aber für die neuen Tokens (Bearer) ist kein `:` enthalten.
  if (token.includes(':')) {
    return `Basic ${Buffer.from(token).toString('base64')}`;
  }
  return `Bearer ${token}`;
}

/**
 * Token-Vorschau für Debug-Logs. Niemals den vollen Token loggen.
 */
function tokenPreview(token: string): string {
  if (token.length <= 4) return '****';
  return `${token.slice(0, 4)}…(${token.length} chars)`;
}

/**
 * Default Cloud API Base URL.
 */
const CLOUD_API_BASE = 'https://api.bitbucket.org/2.0';

/**
 * Bitbucket-Adapter-Implementierung.
 */
export class BitbucketPrAdapter implements PullRequestAdapter {
  public readonly platformName = 'bitbucket';

  private readonly cloud: boolean;
  private readonly apiBase: string;
  private readonly authHeader: string;
  private readonly logger: Logger;

  /**
   * @param config - Bitbucket-spezifische Konfiguration
   * @param token  - Access Token aus GITBULK_BITBUCKET_TOKEN
   * @param logger - Optionaler Logger
   */
  constructor(
    private readonly config: BitbucketConfig,
    token: string,
    logger?: Logger,
  ) {
    // `apiVariant` ist die explizite Entscheidung. Cloud ist Default.
    this.cloud = config.apiVariant !== 'server';
    // Wenn keine eigene URL gesetzt ist, nutze Cloud-Default.
    // Bei Server MUSS apiBaseUrl gesetzt sein — wir validieren das hier nochmal.
    if (!this.cloud && !config.apiBaseUrl) {
      throw new Error('Bitbucket Server mode requires apiBaseUrl');
    }
    this.apiBase = (config.apiBaseUrl ?? CLOUD_API_BASE).replace(/\/+$/, '');
    this.authHeader = buildAuthHeader(token);
    this.logger = logger ?? getDefaultLogger();

    this.logger.debug(
      `Bitbucket adapter ready (${this.cloud ? 'Cloud' : 'Server'}, token=${tokenPreview(token)}, base=${this.apiBase})`,
    );
  }

  /**
   * Erstellt einen Pull Request — oder meldet einen bereits offenen als „updated".
   *
   * Phase 4 des Flowcharts: `API: Create a PR for this RU`.
   *
   * WICHTIG (Re-Run): Wir prüfen ZUERST, ob für den Source-Branch bereits ein
   * offener PR existiert. Bitbucket meldet Duplikate uneinheitlich (Cloud gibt
   * je nach Fall einen 2xx mit dem bestehenden PR oder einen 4xx mit wechselndem
   * Wortlaut zurück) — ein vorgelagerter Lookup ist daher die einzige robuste
   * Art, „erstellt" von „aktualisiert" zu unterscheiden, und verhindert
   * nebenbei Duplikat-PRs beim zweiten Lauf.
   */
  public async createPullRequest(input: CreatePrInput): Promise<CreatePrResult> {
    const existing = await this.findOpenPr(input);
    if (existing) {
      this.logger.debug(`Open PR already exists for ${input.ru} (#${existing.id}) → update`);
      return { ok: true, id: existing.id, url: existing.url, statusCode: 200, updated: true };
    }

    const { url, body } = this.buildRequest(input);
    this.logger.debug(`POST ${url} (source=${input.sourceBranch} → target=${input.targetBranch})`);

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: this.authHeader,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      // Netzwerk-Fehler, DNS, TLS-Probleme — KEIN Throw, sondern Result.
      return {
        ok: false,
        statusCode: 0,
        error: `network error: ${(err as Error).message}`,
      };
    }

    const rawBody = await response.text();

    if (response.status === 200 || response.status === 201) {
      return this.parseSuccess(response.status, rawBody, input);
    }

    // Race-Absicherung: Falls zwischen Lookup und POST doch ein PR entstanden
    // ist (oder Bitbucket das Duplikat erst hier ablehnt), erneut nachschlagen.
    if (response.status === 400 || response.status === 409) {
      const racePr = await this.findOpenPr(input);
      if (racePr) {
        this.logger.debug(`PR appeared concurrently for ${input.ru} (#${racePr.id}) → update`);
        return { ok: true, id: racePr.id, url: racePr.url, statusCode: 200, updated: true };
      }
    }

    return this.parseFailure(response.status, rawBody);
  }

  /**
   * Sucht den bereits offenen PR zum Source-Branch (best-effort).
   * Wird nur aufgerufen, wenn die Create-Antwort „already exists" meldete.
   *
   * Cloud:  GET /repositories/{ws}/{repo}/pullrequests?q=source.branch.name="<b>"&state=OPEN
   * Server: GET /rest/api/1.0/projects/{key}/repos/{repo}/pull-requests
   *           ?state=OPEN&at=refs/heads/<b>&direction=OUTGOING
   */
  private async findOpenPr(input: CreatePrInput): Promise<{ id: number; url: string } | undefined> {
    const url = this.cloud
      ? `${this.apiBase}/repositories/${encodeURIComponent(this.config.workspace)}/${encodeURIComponent(input.ru)}/pullrequests?q=${encodeURIComponent(`source.branch.name="${input.sourceBranch}"`)}&state=OPEN`
      : `${this.apiBase}/rest/api/1.0/projects/${encodeURIComponent(this.config.workspace)}/repos/${encodeURIComponent(input.ru)}/pull-requests?state=OPEN&at=${encodeURIComponent(`refs/heads/${input.sourceBranch}`)}&direction=OUTGOING`;
    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: { Authorization: this.authHeader, Accept: 'application/json' },
      });
      if (res.status !== 200) return undefined;
      const data = JSON.parse(await res.text()) as { values?: Array<Record<string, unknown>> };
      const first = data.values?.[0];
      if (!first || (typeof first.id !== 'number' && typeof first.id !== 'string')) {
        return undefined;
      }
      const id = typeof first.id === 'number' ? first.id : Number(first.id);
      if (!Number.isFinite(id)) return undefined;
      let prUrl: string;
      if (this.cloud) {
        const links = first.links as { html?: { href?: string } } | undefined;
        prUrl =
          links?.html?.href ??
          `https://bitbucket.org/${this.config.workspace}/${input.ru}/pull-requests/${id}`;
      } else {
        const links = first.links as { self?: Array<{ href?: string }> } | undefined;
        prUrl = links?.self?.[0]?.href ?? `${this.apiBase}`;
      }
      return { id, url: prUrl };
    } catch {
      // best-effort — bei Netzwerk-/Parse-Fehler kein Treffer.
      return undefined;
    }
  }

  /**
   * Baut URL und Request-Body je nach Cloud-/Server-Variante.
   *
   * Cloud API:  POST /repositories/{workspace}/{repo}/pullrequests
   * Server API: POST /rest/api/1.0/projects/{key}/repos/{repo}/pull-requests
   *
   * Die Cloud-API erwartet `workspace`; bei Server wird derselbe Wert als
   * Project-Key interpretiert (typische Verwendung in Self-Hosted-Setups).
   */
  private buildRequest(input: CreatePrInput): { url: string; body: object } {
    if (this.cloud) {
      const url = `${this.apiBase}/repositories/${encodeURIComponent(this.config.workspace)}/${encodeURIComponent(input.ru)}/pullrequests`;
      const body: Record<string, unknown> = {
        title: input.title,
        source: { branch: { name: input.sourceBranch } },
        destination: { branch: { name: input.targetBranch } },
      };
      if (input.description !== undefined && input.description.length > 0) {
        body.description = input.description;
      }
      if (input.reviewers.length > 0) {
        // Bitbucket Cloud erwartet `reviewers: [{ uuid: '{...}' }]` oder
        // `[{ account_id: '...' }]`. Wir prüfen das Format und ergänzen
        // dann das passende Feld, damit User beide Formen verwenden können.
        body.reviewers = input.reviewers.map((r) => {
          if (r.startsWith('{') && r.endsWith('}')) {
            return { uuid: r };
          }
          return { account_id: r };
        });
      }
      return { url, body };
    }

    // Bitbucket Server / Data Center
    const url = `${this.apiBase}/rest/api/1.0/projects/${encodeURIComponent(this.config.workspace)}/repos/${encodeURIComponent(input.ru)}/pull-requests`;
    const body: Record<string, unknown> = {
      title: input.title,
      fromRef: { id: `refs/heads/${input.sourceBranch}` },
      toRef: { id: `refs/heads/${input.targetBranch}` },
    };
    if (input.description !== undefined && input.description.length > 0) {
      body.description = input.description;
    }
    if (input.reviewers.length > 0) {
      body.reviewers = input.reviewers.map((name) => ({ user: { name } }));
    }
    return { url, body };
  }

  /**
   * Extrahiert PR-ID und URL aus der Erfolgs-Antwort.
   * Beide Plattformvarianten haben unterschiedliche JSON-Strukturen,
   * also Fallback-freundlich parsen.
   */
  private parseSuccess(statusCode: number, rawBody: string, input: CreatePrInput): CreatePrResult {
    try {
      const data = JSON.parse(rawBody) as Record<string, unknown>;

      if (this.cloud) {
        // Cloud: { id: 123, links: { html: { href: '...' } } }
        const id = (data.id as number | string | undefined) ?? 'unknown';
        const links = data.links as Record<string, { href?: string }> | undefined;
        const url =
          links?.html?.href ??
          `https://bitbucket.org/${this.config.workspace}/${input.ru}/pull-requests/${id}`;
        return { ok: true, id, url, statusCode };
      }

      // Server: { id: 123, links: { self: [{ href: '...' }] } }
      const id = (data.id as number | string | undefined) ?? 'unknown';
      const links = data.links as { self?: Array<{ href?: string }> } | undefined;
      const url = links?.self?.[0]?.href ?? `${this.apiBase}`;
      return { ok: true, id, url, statusCode };
    } catch {
      // Body kein JSON oder unerwartete Struktur — trotzdem als Erfolg
      // werten (HTTP-Status hat ja 200/201 gesagt), aber mit Platzhaltern.
      return {
        ok: true,
        id: 'unknown',
        url: '',
        statusCode,
      };
    }
  }

  /**
   * Wandelt eine Fehler-Antwort in ein Result mit aussagekräftiger Meldung.
   * Versucht, die Plattform-typischen Error-Felder zu extrahieren.
   */
  private parseFailure(statusCode: number, rawBody: string): CreatePrResult {
    let errorMessage = `HTTP ${statusCode}`;
    try {
      const data = JSON.parse(rawBody) as Record<string, unknown>;
      if (this.cloud) {
        // Cloud: { error: { message: '...' } }
        const err = data.error as { message?: string } | undefined;
        if (err?.message) errorMessage = `HTTP ${statusCode}: ${err.message}`;
      } else {
        // Server: { errors: [{ message: '...' }] }
        const errs = data.errors as Array<{ message?: string }> | undefined;
        if (errs && errs.length > 0 && errs[0]?.message) {
          errorMessage = `HTTP ${statusCode}: ${errs[0].message}`;
        }
      }
    } catch {
      // Body nicht JSON-parsebar — Roh-Body kurz anhängen.
      const snippet = rawBody.slice(0, 200).replace(/\s+/g, ' ').trim();
      if (snippet.length > 0) errorMessage = `HTTP ${statusCode}: ${snippet}`;
    }
    return {
      ok: false,
      statusCode,
      error: errorMessage,
      rawBody,
    };
  }
}
