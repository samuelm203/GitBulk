/**
 * Azure-DevOps-Adapter für Pull Requests.
 *
 * Unterstützt Azure DevOps Services (dev.azure.com) und Azure DevOps Server
 * (on-prem). Die API-Basis ist stets `{apiBaseUrl}/{organization}` — für die Cloud
 * also `https://dev.azure.com/{organization}`. Für on-prem zeigt `apiBaseUrl` auf
 * die Instanz-Wurzel OHNE Collection (z. B. `https://tfs.example.com/tfs`) und die
 * Collection wird als `organization` gesetzt (ergibt `…/tfs/DefaultCollection`).
 *
 * Adressierung: Ein Repo wird über `{organization}/{project}/_apis/git/
 * repositories/{repo}` angesprochen. Der `project` kommt aus der Sub-Config; ein
 * Per-RU-`workspace`-Override ersetzt ihn (analog GitHub-Owner / GitLab-namespace).
 *
 * Authentifizierung: Personal Access Token (PAT) als HTTP-Basic-Auth mit leerem
 * Benutzernamen — `Authorization: Basic base64(":" + PAT)` (aus
 * `GITBULK_AZURE_DEVOPS_TOKEN`).
 *
 * Sicherheit: Tokens werden NIE geloggt — nur eine kurze Vorschau für Debug.
 */

import { Buffer } from 'node:buffer';

import type { AzureDevOpsConfig } from '../config/schema.js';
import type {
  CiState,
  CreatePrInput,
  CreatePrResult,
  PrApprovals,
  PrLookupInput,
  PrState,
  PrStatusInfo,
  PullRequestAdapter,
} from './pr-adapter.js';
import { getDefaultLogger, type Logger } from '../utils/logger.js';

/** Default-Root für Azure DevOps Services. Die Organisation wird angehängt. */
const DEFAULT_ROOT = 'https://dev.azure.com';

/** REST-API-Version für alle Calls. */
const API_VERSION = '7.1';

/** Token-Vorschau für Debug-Logs. Niemals den vollen Token loggen. */
function tokenPreview(token: string): string {
  if (token.length <= 4) return '****';
  return `${token.slice(0, 4)}…(${token.length} chars)`;
}

/** Mappt Azures PR-`status` auf den plattform-agnostischen {@link PrState}. */
function mapAzureState(raw: unknown): PrState {
  switch (String(raw)) {
    case 'active':
      return 'open';
    case 'completed':
      return 'merged';
    // abandoned / notSet / sonstiges → declined.
    default:
      return 'declined';
  }
}

/** Mappt einen einzelnen Azure-Status-`state` auf den agnostischen {@link CiState}. */
function mapAzureStatusState(raw: unknown): CiState {
  switch (String(raw)) {
    case 'succeeded':
      return 'passed';
    case 'failed':
    case 'error':
      return 'failed';
    case 'pending':
      return 'running';
    // notApplicable / notSet / unbekannt → none.
    default:
      return 'none';
  }
}

/**
 * Zählt Approvals aus der (in der PR-Antwort eingebetteten) Reviewer-Liste.
 *
 * Azure-Votes: 10 = approved, 5 = approved with suggestions, 0 = kein Vote,
 * -5 = waiting for author, -10 = rejected. Ab `vote >= 5` gilt es als Approval.
 * `required` = Anzahl der als „required" markierten Reviewer (best-effort).
 */
function extractApprovals(reviewers: unknown): PrApprovals | undefined {
  if (!Array.isArray(reviewers)) return undefined;
  let approved = 0;
  let required = 0;
  for (const r of reviewers) {
    const rev = r as { vote?: number; isRequired?: boolean };
    if (typeof rev.vote === 'number' && rev.vote >= 5) approved += 1;
    if (rev.isRequired === true) required += 1;
  }
  const result: PrApprovals = { approved };
  if (required > 0) result.required = required;
  return result;
}

/**
 * Azure-DevOps-Adapter-Implementierung.
 */
export class AzureDevOpsPrAdapter implements PullRequestAdapter {
  public readonly platformName = 'azure-devops';

  private readonly orgBase: string;
  private readonly token: string;
  private readonly logger: Logger;

  constructor(
    private readonly config: AzureDevOpsConfig,
    token: string,
    logger?: Logger,
  ) {
    const root = (config.apiBaseUrl ?? DEFAULT_ROOT).replace(/\/+$/, '');
    this.orgBase = `${root}/${encodeURIComponent(config.organization)}`;
    this.token = token;
    this.logger = logger ?? getDefaultLogger();
    this.logger.debug(
      `Azure DevOps adapter ready (token=${tokenPreview(token)}, base=${this.orgBase})`,
    );
  }

  /** Basic-Auth-Header aus dem PAT (leerer Benutzername). */
  private headers(): Record<string, string> {
    const basic = Buffer.from(`:${this.token}`).toString('base64');
    return {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
  }

  /** Ziel-Projekt (Per-RU-Override hat Vorrang vor der Sub-Config). */
  private projectFor(workspace?: string): string {
    return workspace ?? this.config.project;
  }

  /** Basis-URL der PR-Ressource eines Repos. */
  private pullRequestsUrl(project: string, ru: string): string {
    return `${this.orgBase}/${encodeURIComponent(project)}/_apis/git/repositories/${encodeURIComponent(ru)}/pullrequests`;
  }

  /** Web-Link zum PR (deterministisch aus org/project/repo/id gebaut). */
  private webUrl(project: string, ru: string, id: string | number): string {
    return `${this.orgBase}/${encodeURIComponent(project)}/_git/${encodeURIComponent(ru)}/pullrequest/${String(id)}`;
  }

  /**
   * Erstellt einen Pull Request — oder meldet einen bereits aktiven als „updated".
   *
   * POST {orgBase}/{project}/_apis/git/repositories/{repo}/pullrequests
   * Body: { sourceRefName, targetRefName, title, description?, reviewers? }
   */
  public async createPullRequest(input: CreatePrInput): Promise<CreatePrResult> {
    const project = this.projectFor(input.workspace);
    const url = `${this.pullRequestsUrl(project, input.ru)}?api-version=${API_VERSION}`;
    const body: Record<string, unknown> = {
      sourceRefName: `refs/heads/${input.sourceBranch}`,
      targetRefName: `refs/heads/${input.targetBranch}`,
      title: input.title,
    };
    if (input.description !== undefined && input.description.length > 0) {
      body.description = input.description;
    }
    // Azure erwartet Reviewer als { id: <GUID/Descriptor> }. Strings werden
    // unverändert durchgereicht (keine numerische Konvertierung wie bei GitLab).
    if (input.reviewers.length > 0) {
      body.reviewers = input.reviewers.map((id) => ({ id }));
    }

    this.logger.debug(`POST ${url} (source=${input.sourceBranch} → target=${input.targetBranch})`);

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

    if (response.status === 200 || response.status === 201) {
      return this.parseSuccess(response.status, rawBody, project, input);
    }

    // Re-Run: Azure lehnt einen Duplikat-PR mit 409 (TF401179) ab → aktiven PR
    // zu Source+Target nachschlagen und als „updated" melden (kein zweiter PR).
    if (response.status === 409) {
      const existing = await this.findActivePr(project, input);
      if (existing) {
        this.logger.debug(`PR already exists for ${input.ru} (#${existing.id}) → update`);
        return { ok: true, id: existing.id, url: existing.url, statusCode: 200, updated: true };
      }
    }

    return this.parseFailure(response.status, rawBody);
  }

  /**
   * Schlägt den PR-Status für einen Source-Branch nach (read-only, `gitbulk
   * status`). Sucht über ALLE States und ergänzt best-effort Approvals + CI.
   *
   * GET {…}/pullrequests?searchCriteria.sourceRefName=refs/heads/<b>&searchCriteria.status=all
   */
  public async getPullRequestStatus(input: PrLookupInput): Promise<PrStatusInfo> {
    const project = this.projectFor(input.workspace);
    const sourceRef = encodeURIComponent(`refs/heads/${input.sourceBranch}`);
    const url = `${this.pullRequestsUrl(project, input.ru)}?searchCriteria.sourceRefName=${sourceRef}&searchCriteria.status=all&api-version=${API_VERSION}`;

    let res: Response;
    try {
      res = await fetch(url, { method: 'GET', headers: this.headers() });
    } catch (err) {
      return { state: 'none', error: `network error: ${(err as Error).message}` };
    }

    const rawBody = await res.text();
    if (res.status !== 200) {
      return { state: 'none', error: `HTTP ${res.status}` };
    }

    let data: { value?: unknown };
    try {
      data = JSON.parse(rawBody) as { value?: unknown };
    } catch {
      return { state: 'none', error: 'could not parse API response' };
    }
    const list = Array.isArray(data.value) ? data.value : [];
    if (list.length === 0) return { state: 'none' };

    const pr = list[0] as { pullRequestId?: number; status?: string; reviewers?: unknown };
    const info: PrStatusInfo = { state: mapAzureState(pr.status) };
    if (typeof pr.pullRequestId === 'number') {
      info.id = pr.pullRequestId;
      info.url = this.webUrl(project, input.ru, pr.pullRequestId);

      // Approvals stecken bereits in der Listenantwort (eingebettete Reviewer);
      // nur der CI-Rollup braucht einen zusätzlichen Call.
      const approvals = extractApprovals(pr.reviewers);
      if (approvals !== undefined) info.approvals = approvals;

      const ci = await this.fetchCi(project, input.ru, pr.pullRequestId);
      if (ci !== undefined) info.ci = ci;
    }
    return info;
  }

  /** CI-Rollup (best-effort): PR-Statuses aggregieren (fail > running > passed). */
  private async fetchCi(project: string, ru: string, id: number): Promise<CiState | undefined> {
    try {
      const url = `${this.pullRequestsUrl(project, ru)}/${id}/statuses?api-version=${API_VERSION}`;
      const res = await fetch(url, { method: 'GET', headers: this.headers() });
      if (res.status !== 200) return undefined;
      const data = JSON.parse(await res.text()) as { value?: Array<{ state?: string }> };
      const list = Array.isArray(data.value) ? data.value : [];
      if (list.length === 0) return 'none';

      let hasFailed = false;
      let hasRunning = false;
      let hasPassed = false;
      for (const s of list) {
        switch (mapAzureStatusState(s.state)) {
          case 'failed':
            hasFailed = true;
            break;
          case 'running':
            hasRunning = true;
            break;
          case 'passed':
            hasPassed = true;
            break;
          default:
            break;
        }
      }
      if (hasFailed) return 'failed';
      if (hasRunning) return 'running';
      if (hasPassed) return 'passed';
      return 'none';
    } catch {
      return undefined;
    }
  }

  /**
   * Sucht den bereits aktiven PR zu Source+Target (best-effort, für 409/Re-Run).
   *
   * GET {…}/pullrequests?searchCriteria.sourceRefName=…&searchCriteria.targetRefName=…&searchCriteria.status=active
   */
  private async findActivePr(
    project: string,
    input: CreatePrInput,
  ): Promise<{ id: number; url: string } | undefined> {
    const sourceRef = encodeURIComponent(`refs/heads/${input.sourceBranch}`);
    const targetRef = encodeURIComponent(`refs/heads/${input.targetBranch}`);
    const url =
      `${this.pullRequestsUrl(project, input.ru)}?searchCriteria.sourceRefName=${sourceRef}` +
      `&searchCriteria.targetRefName=${targetRef}&searchCriteria.status=active&api-version=${API_VERSION}`;
    try {
      const res = await fetch(url, { method: 'GET', headers: this.headers() });
      if (res.status !== 200) return undefined;
      const data = JSON.parse(await res.text()) as { value?: unknown };
      const list = Array.isArray(data.value) ? data.value : [];
      if (list.length > 0) {
        const pr = list[0] as { pullRequestId?: number };
        if (typeof pr.pullRequestId === 'number') {
          return { id: pr.pullRequestId, url: this.webUrl(project, input.ru, pr.pullRequestId) };
        }
      }
    } catch {
      // best-effort — bei Netzwerk-/Parse-Fehler kein Treffer.
    }
    return undefined;
  }

  /** Extrahiert die PR-ID aus der Erfolgs-Antwort und baut den Web-Link. */
  private parseSuccess(
    statusCode: number,
    rawBody: string,
    project: string,
    input: CreatePrInput,
  ): CreatePrResult {
    try {
      const data = JSON.parse(rawBody) as { pullRequestId?: number };
      const id = data.pullRequestId ?? 'unknown';
      const url = data.pullRequestId !== undefined ? this.webUrl(project, input.ru, id) : '';
      return { ok: true, id, url, statusCode };
    } catch {
      return { ok: true, id: 'unknown', url: '', statusCode };
    }
  }

  /** Wandelt eine Fehler-Antwort in ein Result mit aussagekräftiger Meldung. */
  private parseFailure(statusCode: number, rawBody: string): CreatePrResult {
    let errorMessage = `HTTP ${statusCode}`;
    try {
      const data = JSON.parse(rawBody) as { message?: unknown };
      const m = data.message;
      if (typeof m === 'string') {
        errorMessage = `HTTP ${statusCode}: ${m}`;
      } else if (m !== undefined && m !== null) {
        errorMessage = `HTTP ${statusCode}: ${JSON.stringify(m)}`;
      }
    } catch {
      const snippet = rawBody.slice(0, 200).replace(/\s+/g, ' ').trim();
      if (snippet.length > 0) errorMessage = `HTTP ${statusCode}: ${snippet}`;
    }
    return { ok: false, statusCode, error: errorMessage, rawBody };
  }
}
