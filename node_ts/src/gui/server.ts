/**
 * Lokaler GUI-Server (`gitbulk --gui`).
 *
 * Express-App mit drei Routen:
 *   GET  /        — die selbstenthaltene GUI-Seite (renderGuiPage)
 *   GET  /events  — SSE-Stream (`progress`, `log`, `started`, `summary`)
 *   POST /start   — startet den injizierten Runner GENAU einmal (sonst 409)
 *
 * Sicherheit: bindet ausschließlich an 127.0.0.1 (ephemerer Port); das Seiten-
 * Modell enthält keinerlei Secrets (Tokens leben nur in Env-Variablen). Der
 * Runner ist als Callback injiziert — der Server kennt weder Git noch HTTP-
 * Adapter und ist dadurch ohne echte Läufe testbar.
 */

import { createServer, type Server } from 'node:http';

import express from 'express';

import type { RunSummary } from '../core/runner.js';
import { renderGuiPage, type GuiPageModel } from './page.js';

/** Optionen für den GUI-Server. */
export interface GuiServerOptions {
  /** Daten fürs initiale Rendern der Seite (keine Secrets!). */
  model: GuiPageModel;
  /** Startet den Bulk-Lauf (wird von POST /start genau einmal aufgerufen). */
  runRunner: () => Promise<RunSummary>;
}

/** Handle auf den laufenden Server. */
export interface GuiServerHandle {
  /** Basis-URL, z. B. `http://127.0.0.1:53124`. */
  url: string;
  port: number;
  /** Sendet ein SSE-Event an alle verbundenen Clients. */
  broadcast(event: string, data: unknown): void;
  /**
   * Erfüllt sich, sobald der (per POST /start ausgelöste) Lauf abgeschlossen
   * ist — mit der RunSummary. Bricht der Runner mit einem Fehler ab, wird
   * das Promise rejected.
   */
  runFinished: Promise<RunSummary>;
  /** Wurde der Lauf bereits gestartet? */
  started(): boolean;
  /** Schließt SSE-Verbindungen und den Server. */
  close(): Promise<void>;
}

/** Startet den Server auf 127.0.0.1 mit ephemerem Port. */
export async function startGuiServer(opts: GuiServerOptions): Promise<GuiServerHandle> {
  const app = express();
  app.disable('x-powered-by');

  // Verbundene SSE-Clients (Response-Objekte).
  const clients = new Set<express.Response>();
  let runStarted = false;

  let resolveFinished!: (s: RunSummary) => void;
  let rejectFinished!: (e: unknown) => void;
  const runFinished = new Promise<RunSummary>((resolve, reject) => {
    resolveFinished = resolve;
    rejectFinished = reject;
  });
  // Rejection kann feuern, bevor der Aufrufer `runFinished` konsumiert (z. B.
  // Crash direkt nach POST /start) — als "handled" markieren, damit Node keine
  // unhandled rejection meldet. Spätere Konsumenten erhalten sie trotzdem.
  runFinished.catch(() => {});

  const broadcast = (event: string, data: unknown): void => {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data ?? {})}\n\n`;
    for (const res of clients) {
      res.write(payload);
    }
  };

  app.get('/', (_req, res) => {
    res.type('html').send(renderGuiPage(opts.model));
  });

  app.get('/events', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    // Initialer Kommentar öffnet den Stream sofort (Proxies/Buffering).
    res.write(': connected\n\n');
    clients.add(res);
    req.on('close', () => {
      clients.delete(res);
    });
  });

  app.post('/start', (_req, res) => {
    if (runStarted) {
      res.status(409).json({ error: 'run already started' });
      return;
    }
    runStarted = true;
    broadcast('started', {});
    // Lauf asynchron starten; Abschluss/Fehler über das Handle-Promise melden.
    opts
      .runRunner()
      .then((summary) => {
        broadcast('summary', summary);
        resolveFinished(summary);
      })
      .catch((err: unknown) => {
        broadcast('log', { line: `[ERROR] run crashed: ${(err as Error).message}` });
        rejectFinished(err);
      });
    res.status(202).json({ ok: true });
  });

  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    broadcast,
    runFinished,
    started: () => runStarted,
    close: () =>
      new Promise<void>((resolve, reject) => {
        for (const res of clients) {
          res.end();
        }
        clients.clear();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
