/**
 * GUI-Seite (`gitbulk --gui`) — ein selbstenthaltenes HTML-Dokument.
 *
 * Bewusst OHNE Frontend-Framework und ohne Build-Schritt: ein einziges
 * Template, Vanilla-CSS/JS. Das Design ist ein nüchternes, helles
 * Desktop-Tool im Stil des Projekt-Mockups (weißer Grund, blaue Prozess-
 * Boxen mit dünnem dunklem Rand, Block-Pfeile, Loop-Pfeil) — die Seite läuft
 * im Chromium-App-Modus als eigenes Fenster ohne Browser-UI.
 *
 * Datenfluss: initiales Modell wird serverseitig eingebettet (nur unkritische
 * Felder — NIE Tokens); Live-Updates kommen als SSE-Events von `/events`
 * (`progress`, `log`, `started`, `summary`). Dynamische Texte werden im Client
 * ausschließlich über `textContent` gesetzt (kein innerHTML) — zusammen mit
 * dem serverseitigen Escaping ist Injection damit strukturell ausgeschlossen.
 */

/** Daten fürs initiale Rendern. Bewusst minimal — keine Secrets, keine Pfade. */
export interface GuiPageModel {
  /** RU-Namen (bereits gegen `^[A-Za-z0-9][A-Za-z0-9._-]*$` validiert). */
  rus: string[];
  dryRun: boolean;
  concurrency: number;
  /** PR-Plattform (bitbucket/github/azure-devops). */
  platform: string;
  /** Ticket-ID (z. B. AKB-1234) — rein informativ im Header. */
  ticket: string;
  /** Feature-Branch-Name (ohne Ticket-Präfix). */
  branch: string;
}

/** Minimales HTML-Escaping für serverseitig eingebettete Strings. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Rendert die komplette GUI-Seite als HTML-String.
 */
export function renderGuiPage(model: GuiPageModel): string {
  const ruRows = model.rus
    .map((ru) => {
      const safe = escapeHtml(ru);
      return [
        `<tr class="ru" data-ru="${safe}" data-status="pending">`,
        `  <td class="c-name">${safe}</td>`,
        '  <td class="c-pipe"><span class="step" data-step="repo">Repo</span><span class="sep">›</span><span class="step" data-step="change">Anpassen</span><span class="sep">›</span><span class="step" data-step="pr">PR</span></td>',
        '  <td class="c-state"><span class="ru-state">wartet</span></td>',
        '  <td class="c-dur"></td>',
        '  <td class="c-detail"><span class="ru-detail"></span></td>',
        '</tr>',
      ].join('\n');
    })
    .join('\n');

  // Initiales Modell für das Client-JS (JSON in <script type="application/json">,
  // damit kein String-Escaping-Risiko in Inline-JS entsteht).
  const bootJson = JSON.stringify({
    total: model.rus.length,
    dryRun: model.dryRun,
  }).replace(/</g, '\\u003c');

  return `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>GitBulk</title>
<style>
  :root {
    --blue: #29abe2;        /* Mockup-Blau */
    --blue-dark: #1788c0;
    --ink: #1d2229;
    --muted: #5f6b7a;
    --line: #d4d9e0;
    --bg: #f3f5f7;
    --ok: #1d7d4f;
    --warn: #946c00;
    --err: #b3261e;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; }
  body {
    background: var(--bg); color: var(--ink);
    font: 14px/1.45 "Segoe UI", system-ui, -apple-system, sans-serif;
    display: flex; flex-direction: column; min-height: 100vh;
  }

  /* ── Kopfzeile ──────────────────────────────────────────────── */
  .top {
    display: flex; align-items: center; gap: 10px;
    padding: 10px 18px; background: #fff; border-bottom: 1px solid var(--line);
  }
  .brand { font-size: 17px; font-weight: 700; }
  .brand b { color: var(--blue-dark); }
  .badge {
    font-size: 12px; color: var(--muted); background: var(--bg);
    border: 1px solid var(--line); border-radius: 3px; padding: 2px 8px; white-space: nowrap;
  }
  .badge.dry { color: #7a5b00; background: #fff7df; border-color: #e3cf8e; }
  .spacer { flex: 1; }
  #runState { font-size: 12.5px; color: var(--muted); margin-right: 4px; }
  #startBtn {
    font: 600 13.5px "Segoe UI", system-ui, sans-serif;
    color: #fff; background: var(--blue-dark);
    border: 1px solid #11699a; border-radius: 3px; padding: 6px 18px; cursor: pointer;
  }
  #startBtn:hover:not(:disabled) { background: #146f9e; }
  #startBtn:disabled { background: #9db8c6; border-color: #9db8c6; cursor: default; }

  /* ── Layout ─────────────────────────────────────────────────── */
  .main { display: grid; grid-template-columns: 320px 1fr; gap: 14px; padding: 14px 18px; flex: 1; align-items: start; }
  @media (max-width: 900px) { .main { grid-template-columns: 1fr; } }
  .panel { background: #fff; border: 1px solid var(--line); border-radius: 4px; }
  .panel h2 {
    margin: 0; padding: 9px 14px; font-size: 12px; font-weight: 600; color: var(--muted);
    text-transform: uppercase; letter-spacing: .05em; border-bottom: 1px solid var(--line);
  }

  /* ── Prozess-Mockup (dem Flowchart-Bild nachempfunden) ─────── */
  .hero-body { padding: 16px 18px 18px; }
  /* Zwei Spalten: links die Box-Säule, rechts der Loop-Pfeil — der Pfeil ist
     dadurch exakt so hoch wie die Boxen und kann nie in die Stats ragen. */
  .flow { display: flex; gap: 8px; }
  .fcol { flex: 1; min-width: 0; }
  .fbox {
    background: var(--blue); color: #fff; font-weight: 600; font-size: 14.5px;
    text-align: center; padding: 13px 10px; border: 1px solid #16374a;
  }
  .fbox.active { background: var(--blue-dark); outline: 2px solid var(--blue-dark); outline-offset: 1px; }
  .farrow { display: flex; justify-content: center; padding: 6px 0; }
  .lcol { position: relative; width: 50px; }
  .lcol .lbody { position: absolute; top: 16px; bottom: 8px; left: 0; width: 100%; }
  .lcol .lbody path { fill: none; stroke: var(--blue); stroke-width: 7; }
  .lcol .lhead { position: absolute; top: 6px; left: 0; }
  .lcol .lhead polygon { fill: var(--blue); stroke: #16374a; stroke-width: 1; }
  .lcol.running .lbody path { stroke-dasharray: 12 9; animation: dash 1.2s linear infinite; }
  @keyframes dash { to { stroke-dashoffset: -21; } }

  .stats { margin-top: 16px; }
  .progress { height: 10px; background: var(--bg); border: 1px solid var(--line); }
  .progress > div { height: 100%; width: 0%; background: var(--blue); transition: width .3s; }
  .meta-row { display: flex; justify-content: space-between; font-size: 12px; color: var(--muted); margin-top: 5px; }
  .counts { margin-top: 12px; font-size: 13px; display: flex; flex-wrap: wrap; gap: 4px 16px; }
  .counts b { font-weight: 600; }
  .counts .ok { color: var(--ok); } .counts .err { color: var(--err); } .counts .warn { color: var(--warn); }

  /* ── RU-Tabelle ─────────────────────────────────────────────── */
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  thead th {
    text-align: left; font-size: 11.5px; font-weight: 600; color: var(--muted);
    text-transform: uppercase; letter-spacing: .04em;
    padding: 8px 12px; border-bottom: 1px solid var(--line); background: #fafbfc;
  }
  tbody td { padding: 8px 12px; border-bottom: 1px solid #e7eaee; vertical-align: top; }
  tbody tr:last-child td { border-bottom: 0; }
  .c-name { font-weight: 600; white-space: nowrap; }
  .c-dur { color: var(--muted); white-space: nowrap; }
  .c-detail { color: var(--muted); word-break: break-word; }
  .c-detail a { color: var(--blue-dark); font-weight: 600; }
  .c-detail .err-text { color: var(--err); }
  .pill {
    display: inline-block; font-size: 10.5px; font-weight: 600; margin-left: 6px;
    border: 1px solid var(--line); border-radius: 3px; padding: 0 5px; color: var(--muted);
  }

  .c-pipe { white-space: nowrap; }
  .sep { color: #b6bec8; margin: 0 4px; }
  .step {
    display: inline-block; font-size: 11.5px; padding: 1px 7px;
    border: 1px solid var(--line); border-radius: 3px; color: var(--muted); background: #fff;
  }
  .step.done   { color: var(--ok); border-color: #bfdccd; background: #eef7f2; }
  .step.active { color: #fff; border-color: var(--blue-dark); background: var(--blue); }
  .step.fail   { color: var(--err); border-color: #e3b9b6; background: #fbeeed; }
  .step.skip   { color: var(--warn); border-color: #e0d2a8; background: #faf5e4; }

  .ru-state { font-size: 12px; color: var(--muted); white-space: nowrap; }
  tr[data-status="running"] .ru-state { color: var(--blue-dark); font-weight: 600; }
  tr[data-status="done"]    .ru-state { color: var(--ok); font-weight: 600; }
  tr[data-status="failed"]  .ru-state { color: var(--err); font-weight: 600; }
  tr[data-status="skipped"] .ru-state { color: var(--warn); font-weight: 600; }

  /* ── Log + Abschluss ────────────────────────────────────────── */
  .logwrap { padding: 0 18px 14px; }
  #log {
    margin: 0; padding: 10px 14px; max-height: 230px; overflow-y: auto;
    font: 12px/1.6 Consolas, "Cascadia Mono", monospace; color: #2b3138;
    white-space: pre-wrap; word-break: break-word; background: #fff;
  }
  #log .l-warn { color: var(--warn); }
  #log .l-error { color: var(--err); }
  #log .l-debug { color: #8a94a0; }
  #doneBanner {
    display: none; margin: 0 18px 12px; padding: 10px 14px; font-weight: 600;
    border: 1px solid #bfdccd; background: #eef7f2; color: var(--ok); border-radius: 4px;
  }
  #doneBanner.failed { border-color: #e3b9b6; background: #fbeeed; color: var(--err); }
  .foot { text-align: center; color: #9aa4b0; font-size: 11px; padding: 0 0 12px; }
</style>
</head>
<body>
  <header class="top">
    <div class="brand">Git<b>Bulk</b></div>
    <span class="badge">${escapeHtml(model.platform)}</span>
    <span class="badge">concurrency ${model.concurrency}</span>
    <span class="badge">${escapeHtml(model.ticket)}-${escapeHtml(model.branch)}</span>
    ${model.dryRun ? '<span class="badge dry">DRY-RUN</span>' : ''}
    <div class="spacer"></div>
    <span id="runState">bereit</span>
    <button id="startBtn">Run starten</button>
  </header>

  <main class="main">
    <section class="panel">
      <h2>Prozess</h2>
      <div class="hero-body">
        <div class="flow">
          <div class="fcol">
            <div class="fbox" id="box-repo">Bitbucket Repo</div>
            <div class="farrow"><svg width="30" height="22" viewBox="0 0 34 26"><polygon points="7,0 27,0 27,12 34,12 17,26 0,12 7,12" fill="#29abe2" stroke="#16374a" stroke-width="1"/></svg></div>
            <div class="fbox" id="box-change">Anpassen</div>
            <div class="farrow"><svg width="30" height="22" viewBox="0 0 34 26"><polygon points="7,0 27,0 27,12 34,12 17,26 0,12 7,12" fill="#29abe2" stroke="#16374a" stroke-width="1"/></svg></div>
            <div class="fbox" id="box-pr">PR erstellen</div>
          </div>
          <div class="lcol" id="loopArrow">
            <svg class="lhead" width="20" height="18" viewBox="0 0 20 18"><polygon points="20,1 0,9 20,17"/></svg>
            <svg class="lbody" viewBox="0 0 50 280" preserveAspectRatio="none">
              <path d="M8,274 C56,240 56,40 14,6" />
            </svg>
          </div>
        </div>

        <div class="stats">
          <div class="progress"><div id="bar"></div></div>
          <div class="meta-row"><span id="progressText">0 / ${model.rus.length} abgeschlossen</span><span id="clock">00:00</span></div>
          <div class="counts">
            <span class="ok"><b id="nCreated">0</b> PRs erstellt</span>
            <span><b id="nUpdated">0</b> aktualisiert</span>
            <span class="err"><b id="nFailed">0</b> fehlgeschlagen</span>
            <span class="warn"><b id="nSkipped">0</b> übersprungen</span>
          </div>
        </div>
      </div>
    </section>

    <section class="panel">
      <h2>Repositories (${model.rus.length})</h2>
      <table>
        <thead><tr><th>Repository</th><th>Schritt</th><th>Status</th><th>Dauer</th><th>Details</th></tr></thead>
        <tbody>
${ruRows}
        </tbody>
      </table>
    </section>
  </main>

  <div id="doneBanner"></div>

  <div class="logwrap">
    <section class="panel">
      <h2>Log</h2>
      <pre id="log"></pre>
    </section>
  </div>
  <div class="foot">GitBulk — lokal (127.0.0.1)</div>

  <script type="application/json" id="boot">${bootJson}</script>
  <script>
  (function () {
    'use strict';
    var boot = JSON.parse(document.getElementById('boot').textContent);
    var total = boot.total;
    var finishedCount = 0;
    var counts = { created: 0, updated: 0, failed: 0, skipped: 0 };
    var startedAt = null;
    var clockTimer = null;
    var runDone = false;

    var $ = function (id) { return document.getElementById(id); };
    var startBtn = $('startBtn');
    var runState = $('runState');
    var logEl = $('log');

    // ── Hero-Aggregation: aktive Stufe = höchste Stage laufender RUs ──
    var ruStage = {}; // ru -> 'git' | 'pr' (nur solange running)
    function refreshHero() {
      var anyPr = false, anyGit = false;
      Object.keys(ruStage).forEach(function (k) {
        if (ruStage[k] === 'pr') anyPr = true;
        if (ruStage[k] === 'git') anyGit = true;
      });
      $('box-repo').classList.toggle('active', anyGit);
      $('box-change').classList.toggle('active', anyGit);
      $('box-pr').classList.toggle('active', anyPr);
      $('loopArrow').classList.toggle('running', (anyGit || anyPr) && !runDone);
    }

    // ── RU-Zeilen ──────────────────────────────────────────────
    function setSteps(row, marks) {
      ['repo', 'change', 'pr'].forEach(function (s) {
        var el = row.querySelector('[data-step="' + s + '"]');
        el.className = 'step' + (marks[s] ? ' ' + marks[s] : '');
      });
    }

    function fmtMs(ms) {
      if (ms < 1000) return ms + ' ms';
      return (ms / 1000).toFixed(1) + ' s';
    }

    function applyProgress(ev) {
      var row = document.querySelector('[data-ru="' + (window.CSS ? CSS.escape(ev.ru) : ev.ru) + '"]');
      if (!row) return;
      var stateEl = row.querySelector('.ru-state');
      var detail = row.querySelector('.ru-detail');
      var durCell = row.querySelector('.c-dur');

      if (ev.status === 'running') {
        row.dataset.status = 'running';
        ruStage[ev.ru] = ev.stage === 'pr' ? 'pr' : 'git';
        if (ev.stage === 'pr') {
          stateEl.textContent = 'PR erstellen';
          setSteps(row, { repo: 'done', change: 'done', pr: 'active' });
        } else {
          stateEl.textContent = 'anpassen';
          setSteps(row, { repo: 'done', change: 'active', pr: '' });
        }
        refreshHero();
        return;
      }

      // Finales Event
      delete ruStage[ev.ru];
      finishedCount++;
      row.dataset.status = ev.status;

      if (ev.status === 'done') {
        counts.created++;
        if (ev.prUpdated) counts.updated++;
        stateEl.textContent = ev.prUpdated ? 'PR aktualisiert' : 'PR erstellt';
        setSteps(row, { repo: 'done', change: 'done', pr: 'done' });
        detail.textContent = '';
        if (ev.prUrl) {
          var a = document.createElement('a');
          a.href = ev.prUrl; a.target = '_blank'; a.rel = 'noopener';
          a.textContent = ev.prId !== undefined ? 'PR #' + ev.prId : 'PR öffnen';
          detail.appendChild(a);
        }
        if (ev.prUpdated) {
          var pill = document.createElement('span');
          pill.className = 'pill'; pill.textContent = 'updated';
          detail.appendChild(pill);
        }
      } else if (ev.status === 'failed') {
        counts.failed++;
        stateEl.textContent = 'fehlgeschlagen';
        setSteps(row, { repo: 'done', change: ev.outcome === 'fatal-error' ? 'fail' : 'done', pr: 'fail' });
        var es = document.createElement('span');
        es.className = 'err-text'; es.textContent = ev.error || 'Fehler';
        detail.textContent = ''; detail.appendChild(es);
      } else {
        counts.skipped++;
        stateEl.textContent = 'übersprungen';
        setSteps(row, { repo: 'skip', change: 'skip', pr: 'skip' });
        detail.textContent = ev.note || '';
      }

      if (ev.durationMs !== undefined) {
        durCell.textContent = fmtMs(ev.durationMs);
      }

      $('nCreated').textContent = String(counts.created);
      $('nUpdated').textContent = String(counts.updated);
      $('nFailed').textContent = String(counts.failed);
      $('nSkipped').textContent = String(counts.skipped);
      $('bar').style.width = Math.round((finishedCount / total) * 100) + '%';
      $('progressText').textContent = finishedCount + ' / ' + total + ' abgeschlossen';
      refreshHero();
    }

    // ── Log-Panel ──────────────────────────────────────────────
    function addLog(data) {
      var span = document.createElement('span');
      var line = data.line || '';
      if (line.indexOf('[ERROR]') !== -1) span.className = 'l-error';
      else if (line.indexOf('[WARN]') !== -1) span.className = 'l-warn';
      else if (line.indexOf('[DEBUG]') !== -1) span.className = 'l-debug';
      span.textContent = line + '\\n';
      logEl.appendChild(span);
      logEl.scrollTop = logEl.scrollHeight;
    }

    // ── Uhr ────────────────────────────────────────────────────
    function tick() {
      if (startedAt === null) return;
      var s = Math.floor((Date.now() - startedAt) / 1000);
      var mm = String(Math.floor(s / 60)).padStart(2, '0');
      var ss = String(s % 60).padStart(2, '0');
      $('clock').textContent = mm + ':' + ss;
    }

    // ── SSE ────────────────────────────────────────────────────
    var es = new EventSource('/events');
    es.addEventListener('progress', function (e) { applyProgress(JSON.parse(e.data)); });
    es.addEventListener('log', function (e) { addLog(JSON.parse(e.data)); });
    es.addEventListener('started', function () {
      startedAt = Date.now();
      clockTimer = setInterval(tick, 500);
      runState.textContent = boot.dryRun ? 'läuft (dry-run)…' : 'läuft…';
      startBtn.disabled = true;
    });
    es.addEventListener('summary', function (e) {
      runDone = true;
      if (clockTimer) clearInterval(clockTimer);
      refreshHero();
      var sum = JSON.parse(e.data);
      var banner = $('doneBanner');
      var failedTotal = (sum.totals.prsFailed || 0) + (sum.totals.fatalErrors || 0);
      banner.style.display = 'block';
      if (failedTotal > 0) banner.classList.add('failed');
      banner.textContent = 'Run beendet — ' + (sum.totals.prsCreated || 0) + ' PRs erstellt, '
        + (sum.totals.prsSkipped || 0) + ' übersprungen, ' + failedTotal + ' fehlgeschlagen ('
        + Math.round((sum.totalDurationMs || 0) / 1000) + ' s). Dieses Fenster behält den Endstand.';
      runState.textContent = 'beendet';
      es.close();
    });
    es.onerror = function () {
      if (!runDone) runState.textContent = 'Verbindung getrennt';
    };

    // ── Start ──────────────────────────────────────────────────
    startBtn.addEventListener('click', function () {
      startBtn.disabled = true;
      fetch('/start', { method: 'POST' }).then(function (res) {
        if (res.status === 409) { runState.textContent = 'läuft bereits'; return; }
        if (!res.ok) { runState.textContent = 'Start fehlgeschlagen'; startBtn.disabled = false; }
      }).catch(function () {
        runState.textContent = 'Start fehlgeschlagen';
        startBtn.disabled = false;
      });
    });
  })();
  </script>
</body>
</html>
`;
}
