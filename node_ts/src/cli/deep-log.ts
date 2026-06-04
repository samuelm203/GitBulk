/**
 * Deep-Log (`--deep-log`): granulares Schritt-für-Schritt-Protokoll.
 *
 * Während des Laufs sammelt eine {@link LogCapture} JEDE Log-Meldung (alle
 * Level). Am Ende wird das Protokoll wahlweise in eine Datei geschrieben
 * (`gitbulk/gitbulk-log-<ts>.log`) oder nach stdout gedruckt. Im echten
 * Terminal entscheidet ein Prompt `[D]ownload or [P]rint?`; in Nicht-TTY-/CI-
 * Umgebungen wird automatisch in die Datei geschrieben.
 */

import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { LogCapture } from '../utils/logger.js';

/** Standard-Zielordner (wie bei `gitbulk init`). */
const GITBULK_DIR = 'gitbulk';

/**
 * Erzeugt einen dateisystem-sicheren Log-Dateinamen mit Zeitstempel
 * (Doppelpunkte/Punkte der ISO-Zeit werden zu `-`).
 */
export function deepLogFileName(date: Date = new Date()): string {
  const ts = date.toISOString().replace(/[:.]/g, '-');
  return `gitbulk-log-${ts}.log`;
}

/**
 * Schreibt das gepufferte Deep-Log in `<dir>/gitbulk-log-<ts>.log` (Ordner wird
 * angelegt) und liefert den geschriebenen Pfad.
 */
export function writeDeepLogFile(capture: LogCapture, dir: string = GITBULK_DIR): string {
  const target = join(dir, deepLogFileName());
  mkdirSync(dir, { recursive: true });
  writeFileSync(target, `${capture.toString()}\n`);
  return target;
}

/**
 * Schließt das Deep-Log ab: im Terminal `[D]ownload`/`[P]rint` abfragen, sonst
 * automatisch in die Datei schreiben. Bei leerem Puffer passiert nichts.
 */
export async function finishDeepLog(
  capture: LogCapture,
  opts: { interactive: boolean },
): Promise<void> {
  if (capture.size === 0) return;

  if (!opts.interactive) {
    const target = writeDeepLogFile(capture);
    process.stderr.write(`Deep log written to ${target}\n`);
    return;
  }

  const rl = createInterface({ input, output });
  try {
    const answer = (await rl.question('\nDeep log: [D]ownload or [P]rint? ')).trim().toLowerCase();
    if (answer.startsWith('p')) {
      output.write(`\n${capture.toString()}\n`);
    } else {
      // Default (inkl. "d"/leer): in die Datei schreiben.
      const target = writeDeepLogFile(capture);
      output.write(`Deep log written to ${target}\n`);
    }
  } finally {
    rl.close();
  }
}
