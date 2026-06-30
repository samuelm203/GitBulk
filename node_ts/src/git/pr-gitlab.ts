/**
 * GitLab-Adapter für Merge Requests (das GitLab-Pendant zum Pull Request).
 *
 * Unterstützt gitlab.com und selbst-gehostete Instanzen (via `apiBaseUrl`, z. B.
 * `https://gitlab.example.com/api/v4`).
 *
 * Projekt-Identifikation: GitLab adressiert Projekte über `<namespace>/<repo>`
 * (URL-encoded). Der `namespace` ist die Gruppe bzw. der User; ein Per-RU-
 * `workspace`-Override ersetzt ihn (analog zu GitHub-Owner / Bitbucket-Workspace).
 *
 * Authentifizierung: `PRIVATE-TOKEN`-Header aus `GITBULK_GITLAB_TOKEN`
 * (Personal / Project / Group Access Token).
 *
 * Sicherheit: Tokens werden NIE geloggt — nur eine kurze Vorschau für Debug.
 */

import type { GitLabConfig } from '../config/schema.js';
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

/** Default-API-Basis für gitlab.com. */
const DEFAULT_API_BASE = 'https://gitlab.com/api/v4';

/** Token-Vorschau für Debug-Logs. Niemals den vollen Token loggen. */
function tokenPreview(token: string): string {
  if (token.length <= 4) return '****';
  return `${token.slice(0, 4)}…(${token.length} chars)`;
}

/** Mappt GitLabs MR-`state` auf den plattform-agnostischen {@link PrState}. */
function mapGitLabState(raw: unknown): PrState {
  switch (String(raw)) {
    case 'opened':
      return 'open';
    case 'merged':
      return 'merged';
    // closed / locked / sonstiges → declined.
    default:
      return 'declined';
  }
}

/** Mappt einen GitLab-Pipeline-Status auf den agnostischen {@link CiState}. */
function mapGitLabPipeline(raw: unknown): CiState {
  switch (String(raw)) {
    case 'success':
      return 'passed';
    case 'failed':
    case 'canceled':
      return 'failed';
    case 'running':
    case 'pending':
    case 'created':
    case 'preparing':
    case 'waiting_for_resource':
    case 'scheduled':
      return 'running';
    // skipped / manual / unbekannt → none.
    default:
      return 'none';
  }
}

/**
 * GitLab-Adapter-Implementierung.
 */
export class GitLabPrAdapter implements PullRequestAdapter {
  public readonly platformName = 'gitlab';

  private readonly apiBase: string;
  private readonly token: string;
  private readonly logger: Logger;

  constructor(
    private readonly config: GitLabConfig,
    token: string,
    logger?: Logger,
  ) {
    this.apiBase = (config.apiBaseUrl ?? DEFAULT_API_BASE).replace(/\/+$/, '');
    this.token = token;
    this.logger = logger ?? getDefaultLogger();
    this.logger.debug(`GitLab adapter ready (token=${tokenPreview(token)}, base=${this.apiBase})`);
  }

  /** Gemeinsame Header für alle GitLab-API-Calls. */
  private headers(): Record<string, string> {
    return {
      'PRIVATE-TOKEN': this.token,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
  }

  /** URL-encoded Projekt-Pfad `<namespace>/<repo>` (Per-RU-Override beachtet). */
  private projectPath(ru: string, workspace?: string): string {
    const ns = workspace ?? this.config.namespace;
    return encodeURIComponent(`${ns}/${ru}`);
  }

  /**
   * Erstellt einen Merge Request — oder meldet einen bereits offenen als „updated".
   *
   * POST {apiBase}/projects/{ns%2Frepo}/merge_requests
   * Body: { source_branch, target_branch, title, description, reviewer_ids? }
   */
  public async createPullRequest(input: CreatePrInput): Promise<CreatePrResult> {
    const project = this.projectPath(input.ru, input.workspace);
    const url = `${this.apiBase}/projects/${project}/merge_requests`;
    const body: Record<string, unknown> = {
      source_branch: input.sourceBranch,
      target_branch: input.targetBranch,
      title: input.title,
    };
    if (input.description !== undefined && input.description.length > 0) {
      body.description = input.description;
    }
    // GitLab erwartet numerische User-IDs für Reviewer. Nicht-numerische
    // Einträge werden übersprungen (best-effort).
    const reviewerIds = input.reviewers
      .map((r) => Number(r))
      .filter((n) => Number.isInteger(n) && n > 0);
    if (reviewerIds.length > 0) body.reviewer_ids = reviewerIds;

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
      return this.parseSuccess(response.status, rawBody, input);
    }

    // Re-Run: GitLab lehnt einen Duplikat-MR mit 409 ab → bestehenden offenen
    // MR nachschlagen und als „updated" melden (kein zweiter MR).
    if (response.status === 409) {
      const existing = await this.findOpenMr(input.ru, input.sourceBranch, input.workspace);
      if (existing) {
        this.logger.debug(`MR already exists for ${input.ru} (!${existing.id}) → update`);
        return { ok: true, id: existing.id, url: existing.url, statusCode: 200, updated: true };
      }
    }

    return this.parseFailure(response.status, rawBody);
  }

  /**
   * Schlägt den MR-Status für einen Source-Branch nach (read-only, `gitbulk
   * status`). Sucht über ALLE States und ergänzt best-effort Approvals + CI.
   *
   * GET {apiBase}/projects/{ns%2Frepo}/merge_requests?source_branch=<b>&state=all
   */
  public async getPullRequestStatus(input: PrLookupInput): Promise<PrStatusInfo> {
    const project = this.projectPath(input.ru, input.workspace);
    const url = `${this.apiBase}/projects/${project}/merge_requests?source_branch=${encodeURIComponent(input.sourceBranch)}&state=all&order_by=created_at&sort=desc`;

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

    let data: unknown;
    try {
      data = JSON.parse(rawBody);
    } catch {
      return { state: 'none', error: 'could not parse API response' };
    }
    if (!Array.isArray(data) || data.length === 0) return { state: 'none' };

    const mr = data[0] as { iid?: number; web_url?: string; state?: string };
    const info: PrStatusInfo = { state: mapGitLabState(mr.state) };
    if (typeof mr.iid === 'number') {
      info.id = mr.iid;
      if (mr.web_url) info.url = mr.web_url;

      const [approvals, ci] = await Promise.all([
        this.fetchApprovals(project, mr.iid),
        this.fetchCi(project, mr.iid),
      ]);
      if (approvals !== undefined) info.approvals = approvals;
      if (ci !== undefined) info.ci = ci;
    }
    return info;
  }

  /** Approvals (best-effort): GET /merge_requests/{iid}/approvals. */
  private async fetchApprovals(project: string, iid: number): Promise<PrApprovals | undefined> {
    try {
      const res = await fetch(`${this.apiBase}/projects/${project}/merge_requests/${iid}/approvals`, {
        method: 'GET',
        headers: this.headers(),
      });
      if (res.status !== 200) return undefined;
      const data = JSON.parse(await res.text()) as {
        approved_by?: unknown[];
        approvals_required?: number;
      };
      const approved = Array.isArray(data.approved_by) ? data.approved_by.length : 0;
      const result: PrApprovals = { approved };
      if (typeof data.approvals_required === 'number') result.required = data.approvals_required;
      return result;
    } catch {
      return undefined;
    }
  }

  /** CI-Rollup (best-effort): jüngste MR-Pipeline. */
  private async fetchCi(project: string, iid: number): Promise<CiState | undefined> {
    try {
      const res = await fetch(`${this.apiBase}/projects/${project}/merge_requests/${iid}/pipelines`, {
        method: 'GET',
        headers: this.headers(),
      });
      if (res.status !== 200) return undefined;
      const data = JSON.parse(await res.text()) as Array<{ status?: string }>;
      if (!Array.isArray(data) || data.length === 0) return 'none';
      return mapGitLabPipeline(data[0]?.status);
    } catch {
      return undefined;
    }
  }

  /**
   * Sucht den bereits offenen MR zum Source-Branch (best-effort).
   *
   * GET {apiBase}/projects/{ns%2Frepo}/merge_requests?source_branch=<b>&state=opened
   */
  private async findOpenMr(
    ru: string,
    sourceBranch: string,
    workspace?: string,
  ): Promise<{ id: number; url: string } | undefined> {
    const project = this.projectPath(ru, workspace);
    const url = `${this.apiBase}/projects/${project}/merge_requests?source_branch=${encodeURIComponent(sourceBranch)}&state=opened`;
    try {
      const res = await fetch(url, { method: 'GET', headers: this.headers() });
      if (res.status !== 200) return undefined;
      const data = JSON.parse(await res.text()) as unknown;
      if (Array.isArray(data) && data.length > 0) {
        const mr = data[0] as { iid?: number; web_url?: string };
        if (typeof mr.iid === 'number') return { id: mr.iid, url: mr.web_url ?? '' };
      }
    } catch {
      // best-effort — bei Netzwerk-/Parse-Fehler kein Treffer.
    }
    return undefined;
  }

  /** Extrahiert MR-IID und Web-URL aus der Erfolgs-Antwort. */
  private parseSuccess(statusCode: number, rawBody: string, input: CreatePrInput): CreatePrResult {
    try {
      const data = JSON.parse(rawBody) as { iid?: number; web_url?: string };
      const id = data.iid ?? 'unknown';
      const ns = input.workspace ?? this.config.namespace;
      const webHost = this.apiBase.replace(/\/api\/v4$/, '');
      const url = data.web_url ?? `${webHost}/${ns}/${input.ru}/-/merge_requests/${String(id)}`;
      return { ok: true, id, url, statusCode };
    } catch {
      return { ok: true, id: 'unknown', url: '', statusCode };
    }
  }

  /** Wandelt eine Fehler-Antwort in ein Result mit aussagekräftiger Meldung. */
  private parseFailure(statusCode: number, rawBody: string): CreatePrResult {
    let errorMessage = `HTTP ${statusCode}`;
    try {
      const data = JSON.parse(rawBody) as { message?: unknown; error?: unknown };
      const m = data.message ?? data.error;
      if (typeof m === 'string') {
        errorMessage = `HTTP ${statusCode}: ${m}`;
      } else if (Array.isArray(m)) {
        errorMessage = `HTTP ${statusCode}: ${m.map((x) => String(x)).join('; ')}`;
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
