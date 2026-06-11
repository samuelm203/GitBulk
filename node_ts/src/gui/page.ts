/**
 * GUI-Seite (`gitbulk --gui`) — ein selbstenthaltenes HTML-Dokument.
 *
 * Bewusst OHNE Frontend-Framework und ohne Build-Schritt: ein einziges
 * Template, Vanilla-CSS/JS. Das Design folgt dem Prozess-Mockup des Projekts
 * (blaue Boxen „Bitbucket Repo" → „Anpassen" → „PR erstellen" mit Loop-Pfeil)
 * auf einem dunklen Dashboard-Theme.
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
  const ruCards = model.rus
    .map((ru) => {
      const safe = escapeHtml(ru);
      return [
        `<article class="ru" id="ru-${safe}" data-ru="${safe}" data-status="pending">`,
        `  <header><span class="ru-name">${safe}</span><span class="ru-state">pending</span></header>`,
        '  <ol class="pipe">',
        '    <li class="step" data-step="repo">Repo</li>',
        '    <li class="step" data-step="change">Anpassen</li>',
        '    <li class="step" data-step="pr">PR erstellen</li>',
        '  </ol>',
        '  <footer class="ru-detail"></footer>',
        '</article>',
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
<title>GitBulk — Live Run</title>
<style>
  :root {
    --bg: #0b1220;
    --panel: #111a2c;
    --panel-2: #0e1626;
    --line: #20304d;
    --text: #e6edf7;
    --muted: #8ea0bd;
    --accent: #1ca9e0;       /* Mockup-Blau */
    --accent-deep: #0e7fb3;
    --ok: #2ecc8f;
    --warn: #e8c352;
    --err: #ff6b6b;
    --radius: 14px;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; }
  body {
    background:
      radial-gradient(1100px 500px at 85% -10%, rgba(28,169,224,.14), transparent 60%),
      radial-gradient(900px 500px at -10% 110%, rgba(28,169,224,.08), transparent 55%),
      var(--bg);
    color: var(--text);
    font: 15px/1.5 Inter, "Segoe UI", system-ui, -apple-system, sans-serif;
    display: flex; flex-direction: column; min-height: 100vh;
  }

  /* ── Header ─────────────────────────────────────────────────── */
  .top {
    display: flex; align-items: center; gap: 14px;
    padding: 16px 26px; border-bottom: 1px solid var(--line);
    background: rgba(13,20,35,.75); backdrop-filter: blur(6px);
    position: sticky; top: 0; z-index: 5;
  }
  .brand { font-size: 21px; font-weight: 800; letter-spacing: .3px; }
  .brand b { color: var(--accent); }
  .badge {
    font-size: 12px; font-weight: 600; color: var(--muted);
    border: 1px solid var(--line); border-radius: 999px; padding: 3px 11px;
    background: var(--panel-2); white-space: nowrap;
  }
  .badge.dry { color: #0a0f1a; background: var(--warn); border-color: var(--warn); }
  .spacer { flex: 1; }
  #startBtn {
    font: 600 15px Inter, "Segoe UI", system-ui, sans-serif;
    color: #04222e; background: linear-gradient(180deg, #2cc1f7, var(--accent));
    border: 0; border-radius: 10px; padding: 10px 26px; cursor: pointer;
    box-shadow: 0 6px 18px rgba(28,169,224,.35);
    transition: transform .15s ease, box-shadow .15s ease, opacity .2s;
  }
  #startBtn:hover:not(:disabled) { transform: translateY(-1px); box-shadow: 0 8px 22px rgba(28,169,224,.45); }
  #startBtn:disabled { opacity: .45; cursor: default; box-shadow: none; }
  #runState { font-size: 13px; color: var(--muted); min-width: 110px; text-align: right; }

  /* ── Layout ─────────────────────────────────────────────────── */
  .main { display: grid; grid-template-columns: 360px 1fr; gap: 22px; padding: 22px 26px; flex: 1; }
  @media (max-width: 980px) { .main { grid-template-columns: 1fr; } }
  .card {
    background: linear-gradient(180deg, var(--panel), var(--panel-2));
    border: 1px solid var(--line); border-radius: var(--radius);
    box-shadow: 0 14px 34px rgba(0,0,0,.35);
  }

  /* ── Hero: Prozess-Mockup ───────────────────────────────────── */
  .hero { padding: 22px; display: flex; flex-direction: column; gap: 18px; align-self: start; }
  .hero h2 { margin: 0; font-size: 13px; font-weight: 700; letter-spacing: .12em; color: var(--muted); text-transform: uppercase; }
  .flow { position: relative; padding-right: 64px; }
  .fbox {
    background: linear-gradient(180deg, #25b5ec, var(--accent-deep));
    color: #fff; font-weight: 700; font-size: 16px; text-align: center;
    border-radius: 10px; padding: 16px 12px;
    border: 1px solid rgba(255,255,255,.25);
    box-shadow: inset 0 1px 0 rgba(255,255,255,.25), 0 8px 18px rgba(10,40,60,.45);
    transition: box-shadow .3s, filter .3s;
  }
  .fbox.active { animation: glow 1.4s ease-in-out infinite; }
  @keyframes glow {
    0%, 100% { box-shadow: inset 0 1px 0 rgba(255,255,255,.25), 0 0 0 0 rgba(44,193,247,.0); filter: brightness(1); }
    50%      { box-shadow: inset 0 1px 0 rgba(255,255,255,.25), 0 0 26px 4px rgba(44,193,247,.55); filter: brightness(1.18); }
  }
  .farrow { display: flex; justify-content: center; padding: 7px 0; }
  .farrow svg { display: block; }
  .loop { position: absolute; top: 12px; bottom: 12px; right: 6px; width: 52px; }
  .loop path { fill: none; stroke: var(--accent); stroke-width: 7; stroke-linecap: round; opacity: .9; }
  .loop.running path { stroke-dasharray: 14 12; animation: dash 1.1s linear infinite; }
  @keyframes dash { to { stroke-dashoffset: -26; } }
  .loop polygon { fill: var(--accent); }

  /* Stats unter dem Mockup */
  .stats { display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px; }
  .stat { background: var(--panel-2); border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; }
  .stat .v { font-size: 22px; font-weight: 800; }
  .stat .l { font-size: 11px; color: var(--muted); letter-spacing: .08em; text-transform: uppercase; }
  .v.ok { color: var(--ok); } .v.err { color: var(--err); } .v.warn { color: var(--warn); }
  .progress { height: 8px; border-radius: 999px; background: var(--panel-2); border: 1px solid var(--line); overflow: hidden; }
  .progress > div { height: 100%; width: 0%; background: linear-gradient(90deg, var(--accent), #5fd0f7); transition: width .4s ease; }
  .meta-row { display: flex; justify-content: space-between; font-size: 12.5px; color: var(--muted); }

  /* ── RU-Grid ────────────────────────────────────────────────── */
  .runs { padding: 18px; display: flex; flex-direction: column; gap: 12px; min-width: 0; }
  .runs h2 { margin: 2px 4px 6px; font-size: 13px; font-weight: 700; letter-spacing: .12em; color: var(--muted); text-transform: uppercase; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); gap: 12px; }
  .ru {
    background: var(--panel-2); border: 1px solid var(--line); border-radius: 12px;
    padding: 12px 14px; display: flex; flex-direction: column; gap: 10px;
    transition: border-color .25s, box-shadow .25s;
  }
  .ru[data-status="running"] { border-color: var(--accent); box-shadow: 0 0 0 1px rgba(28,169,224,.35), 0 6px 18px rgba(28,169,224,.12); }
  .ru[data-status="done"]    { border-color: rgba(46,204,143,.55); }
  .ru[data-status="failed"]  { border-color: rgba(255,107,107,.6); }
  .ru[data-status="skipped"] { border-color: rgba(232,195,82,.45); }
  .ru header { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
  .ru-name { font-weight: 700; font-size: 14.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ru-state { font-size: 11px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: var(--muted); }
  .ru[data-status="running"] .ru-state { color: var(--accent); }
  .ru[data-status="done"]    .ru-state { color: var(--ok); }
  .ru[data-status="failed"]  .ru-state { color: var(--err); }
  .ru[data-status="skipped"] .ru-state { color: var(--warn); }

  .pipe { list-style: none; display: flex; gap: 6px; margin: 0; padding: 0; }
  .step {
    flex: 1; text-align: center; font-size: 11px; font-weight: 600; color: var(--muted);
    border: 1px solid var(--line); border-radius: 7px; padding: 5px 2px;
    background: rgba(255,255,255,.02); position: relative; transition: all .25s;
  }
  .step.done { color: #062a1d; background: var(--ok); border-color: var(--ok); }
  .step.active { color: #04222e; background: var(--accent); border-color: var(--accent); animation: stepPulse 1.2s ease-in-out infinite; }
  .step.fail { color: #2a0606; background: var(--err); border-color: var(--err); }
  .step.skip { color: #2a2206; background: var(--warn); border-color: var(--warn); }
  @keyframes stepPulse { 0%,100% { filter: brightness(1); } 50% { filter: brightness(1.3); } }

  .ru-detail { font-size: 12.5px; color: var(--muted); min-height: 18px; word-break: break-word; }
  .ru-detail a { color: var(--accent); font-weight: 600; text-decoration: none; }
  .ru-detail a:hover { text-decoration: underline; }
  .ru-detail .err-text { color: var(--err); }
  .pill { display: inline-block; font-size: 10.5px; font-weight: 700; border-radius: 999px; padding: 1px 8px; margin-left: 6px; background: rgba(28,169,224,.18); color: var(--accent); }

  /* ── Log-Panel ──────────────────────────────────────────────── */
  .logwrap { margin: 0 26px 22px; }
  details.card { overflow: hidden; }
  details summary {
    cursor: pointer; padding: 12px 18px; font-weight: 700; font-size: 13px;
    letter-spacing: .1em; text-transform: uppercase; color: var(--muted);
    user-select: none; list-style: none; display: flex; align-items: center; gap: 10px;
  }
  details summary::before { content: "▸"; color: var(--accent); transition: transform .2s; }
  details[open] summary::before { transform: rotate(90deg); }
  #log {
    margin: 0; padding: 6px 18px 16px; max-height: 260px; overflow-y: auto;
    font: 12.5px/1.65 Consolas, "Cascadia Mono", monospace; color: #b9c7dd;
    white-space: pre-wrap; word-break: break-word;
  }
  #log .l-warn { color: var(--warn); }
  #log .l-error { color: var(--err); }
  #log .l-debug { color: #64748b; }

  /* ── Abschluss-Banner ───────────────────────────────────────── */
  #doneBanner {
    display: none; margin: 0 26px 18px; padding: 13px 18px; border-radius: var(--radius);
    border: 1px solid rgba(46,204,143,.5); background: rgba(46,204,143,.12);
    color: var(--ok); font-weight: 700;
  }
  #doneBanner.failed { border-color: rgba(255,107,107,.5); background: rgba(255,107,107,.1); color: var(--err); }
  .foot { text-align: center; color: #5b6b85; font-size: 11.5px; padding: 0 0 16px; }
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
    <section class="card hero">
      <h2>Prozess</h2>
      <div class="flow">
        <div class="fbox" id="box-repo">Bitbucket Repo</div>
        <div class="farrow"><svg width="34" height="26" viewBox="0 0 34 26"><polygon points="7,0 27,0 27,12 34,12 17,26 0,12 7,12" fill="var(--accent)"/></svg></div>
        <div class="fbox" id="box-change">Anpassen</div>
        <div class="farrow"><svg width="34" height="26" viewBox="0 0 34 26"><polygon points="7,0 27,0 27,12 34,12 17,26 0,12 7,12" fill="var(--accent)"/></svg></div>
        <div class="fbox" id="box-pr">PR erstellen</div>
        <svg class="loop" id="loopArrow" viewBox="0 0 52 300" preserveAspectRatio="none">
          <path d="M6,278 C58,250 58,50 14,24" />
          <polygon points="22,30 2,18 16,4" />
        </svg>
      </div>

      <div class="progress"><div id="bar"></div></div>
      <div class="meta-row"><span id="progressText">0 / ${model.rus.length} abgeschlossen</span><span id="clock">00:00</span></div>

      <div class="stats">
        <div class="stat"><div class="v ok" id="nCreated">0</div><div class="l">PRs erstellt</div></div>
        <div class="stat"><div class="v" id="nUpdated">0</div><div class="l">aktualisiert</div></div>
        <div class="stat"><div class="v err" id="nFailed">0</div><div class="l">fehlgeschlagen</div></div>
        <div class="stat"><div class="v warn" id="nSkipped">0</div><div class="l">übersprungen</div></div>
      </div>
    </section>

    <section class="card runs">
      <h2>Repositories (${model.rus.length})</h2>
      <div class="grid">
${ruCards}
      </div>
    </section>
  </main>

  <div id="doneBanner"></div>

  <div class="logwrap">
    <details class="card" open>
      <summary>Live-Log</summary>
      <pre id="log"></pre>
    </details>
  </div>
  <div class="foot">GitBulk GUI — lokal (127.0.0.1), read-only Ansicht des Laufs</div>

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

    // ── RU-Karten ──────────────────────────────────────────────
    function setSteps(card, marks) {
      // marks: {repo:'done|active|fail|skip|', change:…, pr:…}
      ['repo', 'change', 'pr'].forEach(function (s) {
        var el = card.querySelector('[data-step="' + s + '"]');
        el.className = 'step' + (marks[s] ? ' ' + marks[s] : '');
      });
    }

    function fmtMs(ms) {
      if (ms < 1000) return ms + ' ms';
      return (ms / 1000).toFixed(1) + ' s';
    }

    function applyProgress(ev) {
      var card = document.querySelector('[data-ru="' + (window.CSS ? CSS.escape(ev.ru) : ev.ru) + '"]');
      if (!card) return;
      var stateEl = card.querySelector('.ru-state');
      var detail = card.querySelector('.ru-detail');

      if (ev.status === 'running') {
        card.dataset.status = 'running';
        ruStage[ev.ru] = ev.stage === 'pr' ? 'pr' : 'git';
        if (ev.stage === 'pr') {
          stateEl.textContent = 'PR erstellen';
          setSteps(card, { repo: 'done', change: 'done', pr: 'active' });
        } else {
          stateEl.textContent = 'anpassen';
          setSteps(card, { repo: 'done', change: 'active', pr: '' });
        }
        refreshHero();
        return;
      }

      // Finales Event
      delete ruStage[ev.ru];
      finishedCount++;
      card.dataset.status = ev.status;

      if (ev.status === 'done') {
        counts.created++;
        if (ev.prUpdated) counts.updated++;
        stateEl.textContent = ev.prUpdated ? 'PR aktualisiert' : 'PR erstellt';
        setSteps(card, { repo: 'done', change: 'done', pr: 'done' });
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
        setSteps(card, { repo: 'done', change: ev.outcome === 'fatal-error' ? 'fail' : 'done', pr: 'fail' });
        var es = document.createElement('span');
        es.className = 'err-text'; es.textContent = ev.error || 'Fehler';
        detail.textContent = ''; detail.appendChild(es);
      } else {
        counts.skipped++;
        stateEl.textContent = 'übersprungen';
        setSteps(card, { repo: 'skip', change: 'skip', pr: 'skip' });
        detail.textContent = ev.note || '';
      }

      if (ev.durationMs !== undefined) {
        var d = document.createElement('span');
        d.textContent = (detail.textContent || detail.childNodes.length ? '  ·  ' : '') + fmtMs(ev.durationMs);
        detail.appendChild(d);
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
      span.textContent = line;
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
        + Math.round((sum.totalDurationMs || 0) / 1000) + ' s). Diese Seite behält den Endstand.';
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
