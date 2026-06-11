/**
 * Log-Brücke für den GUI-Modus.
 *
 * Implementiert das `LogSink`-Interface des Loggers: jede Log-Zeile wird
 * (1) ans Terminal durchgereicht (stderr — das Terminal bleibt informativ) und
 * (2) ANSI-bereinigt als SSE-`log`-Event an die GUI gebroadcastet, wo sie im
 * Live-Log-Panel erscheint.
 */

import { Buffer } from 'node:buffer';

import type { LogSink } from '../utils/logger.js';

/** Entfernt ANSI-CSI-Sequenzen (Farben) für die Browser-Darstellung. */
// eslint-disable-next-line no-control-regex
const ANSI_SEQ = /\u001b\[[0-9;?]*[A-Za-z]/g;

export class GuiLogSink implements LogSink {
  /**
   * @param passthrough - Terminal-Senke (typisch `process.stderr`).
   * @param broadcast   - SSE-Broadcast des GUI-Servers (`handle.broadcast`).
   */
  constructor(
    private readonly passthrough: LogSink,
    private readonly broadcast: (event: string, data: unknown) => void,
  ) {}

  write(chunk: string | Uint8Array): boolean {
    const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    const ok = this.passthrough.write(text);
    // Zeilenweise an die GUI (Logger schreibt zeilenweise; defensiv splitten).
    for (const line of text.replace(ANSI_SEQ, '').split('\n')) {
      if (line.trim().length > 0) {
        this.broadcast('log', { line });
      }
    }
    return ok;
  }
}
