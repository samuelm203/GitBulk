/**
 * Log-Puffer für den TUI-Modus.
 *
 * Problem: Der Live-Renderer zeichnet in-place via cursor-up/clear-line auf
 * stdout. Auch Logs auf **stderr** landen im Terminal auf demselben Bildschirm —
 * jede Warnung während des Laufs (Push-Fehler, Konflikt-Skip, …) schiebt den
 * Frame nach unten, die cursor-up-Zeilenzahl des Renderers stimmt nicht mehr
 * und die Darstellung zerreißt.
 *
 * Lösung: Während der Live-Renderer aktiv ist (`beginBuffering()`), werden alle
 * Log-Zeilen hier gesammelt statt geschrieben. Nach `renderer.stop()` gibt
 * `flush()` sie gesammelt auf der Ziel-Senke aus — nichts geht verloren, aber
 * die Live-Ansicht bleibt intakt. Außerhalb der Pufferphase schreibt die Senke
 * direkt durch (Echtzeit-Logs vor/nach dem Live-Rendering).
 */

import { Buffer } from 'node:buffer';

import type { LogSink } from '../utils/logger.js';

export class TuiLogBuffer implements LogSink {
  private buffering = false;
  private chunks: string[] = [];

  /** @param target - Ziel-Senke für Durchreichen + Flush (typisch: `process.stderr`). */
  constructor(private readonly target: LogSink) {}

  /** Stream-API für den Logger: puffert oder reicht direkt durch. */
  write(chunk: string | Uint8Array): boolean {
    const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    if (this.buffering) {
      this.chunks.push(text);
      return true;
    }
    return this.target.write(text);
  }

  /** Ab jetzt puffern (Live-Renderer übernimmt das Terminal). */
  beginBuffering(): void {
    this.buffering = true;
  }

  /** Anzahl gepufferter Chunks (für Tests/Anzeige). */
  get size(): number {
    return this.chunks.length;
  }

  /**
   * Pufferung beenden und alles Aufgelaufene in Originalreihenfolge auf die
   * Ziel-Senke schreiben. Idempotent — ein leerer Puffer ist ein No-op.
   */
  flush(): void {
    this.buffering = false;
    if (this.chunks.length === 0) return;
    const all = this.chunks.join('');
    this.chunks = [];
    this.target.write(all);
  }
}
