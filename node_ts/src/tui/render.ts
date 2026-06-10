/**
 * TUI-Render-Logik (Zero-Dependency).
 *
 * Zeichnet eine live-aktualisierte Liste von RUs mit Status-Symbolen, plus
 * eine Kopf- und Fußzeile. Verwendet ausschließlich ANSI-Escape-Codes und
 * Node-Builtins — keine externen Bibliotheken.
 *
 * Trennung der Verantwortlichkeiten:
 *   - Diese Datei kümmert sich NUR ums Zeichnen (reine Funktionen + ein
 *     schlanker Renderer, der weiß, wie viele Zeilen er zuletzt gezeichnet hat).
 *   - Die Orchestrierung (Config laden, Runner starten, Events einspeisen)
 *     liegt in `index.ts`.
 *
 * Render-Strategie:
 *   Beim ersten `render()` wird die Liste einfach ausgegeben und die Zeilenzahl
 *   gemerkt. Bei jedem weiteren `render()` fährt der Cursor um genau diese
 *   Anzahl Zeilen hoch und überschreibt sie. So entsteht der "Live-Update"-
 *   Effekt ohne Flackern und ohne den Scroll-Verlauf zu fluten.
 */

/** Status einer Zeile in der TUI. */
export type TuiRuStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';

/** Eine Zeile in der RU-Liste. */
export interface TuiRuRow {
  ru: string;
  status: TuiRuStatus;
  /** Optionaler Detailtext (z. B. PR-Nummer oder Fehlermeldung). */
  detail?: string;
}

/** Optionen für den Renderer. */
export interface TuiRenderOptions {
  /** Ausgabe-Stream (Default: process.stdout). Für Tests überschreibbar. */
  out?: NodeJS.WritableStream;
  /** Farben deaktivieren (z. B. wenn kein TTY oder NO_COLOR gesetzt). */
  noColor?: boolean;
  /** Titel über der Liste. */
  title?: string;
  /**
   * Aktueller Spinner-Frame-Index für animierte `running`-Zeilen.
   * Wenn weggelassen, wird das statische `◐`-Symbol genutzt.
   */
  spinnerFrame?: number;
  /** Spinner-Animation komplett deaktivieren (statisches Symbol). */
  noSpinner?: boolean;
  /**
   * "Plain"-Modus für Nicht-TTY-Umgebungen (Pipes, Dateien, CI): keine
   * Cursor-Steuerung, kein In-place-Redraw. Es wird pro Status-Änderung
   * höchstens einmal eine Zeile ausgegeben und am Ende der Endzustand.
   */
  plain?: boolean;
}

// ── ANSI-Helfer ────────────────────────────────────────────────────

const ANSI = {
  reset: '\u001b[0m',
  bold: '\u001b[1m',
  dim: '\u001b[2m',
  green: '\u001b[32m',
  red: '\u001b[31m',
  yellow: '\u001b[33m',
  cyan: '\u001b[36m',
  gray: '\u001b[90m',
  hideCursor: '\u001b[?25l',
  showCursor: '\u001b[?25h',
  /** Cursor um n Zeilen hoch. */
  cursorUp: (n: number): string => (n > 0 ? `\u001b[${n}A` : ''),
  /** Ganze Zeile löschen. */
  clearLine: '\u001b[2K',
  /** Cursor an Zeilenanfang. */
  lineStart: '\r',
};

/**
 * Spinner-Frames für laufende RUs. Braille-Punkte erzeugen einen flüssigen,
 * platzsparenden Rotations-Effekt (ein Zeichen breit, terminal-üblich).
 */
export const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;

/**
 * Intervall zwischen zwei Spinner-Frames in Millisekunden.
 */
export const SPINNER_INTERVAL_MS = 80;

/**
 * Symbol + Farbe pro Status.
 *
 * Für `running` wird – sofern ein `spinnerFrame`-Index übergeben wird – ein
 * animiertes Braille-Spinner-Zeichen statt des statischen Symbols verwendet.
 */
function statusVisual(
  status: TuiRuStatus,
  spinnerFrame?: number,
): { symbol: string; color: string; label: string } {
  switch (status) {
    case 'pending':
      return { symbol: '○', color: ANSI.gray, label: 'pending' };
    case 'running': {
      const symbol =
        spinnerFrame === undefined
          ? '◐'
          : SPINNER_FRAMES[spinnerFrame % SPINNER_FRAMES.length]!;
      return { symbol, color: ANSI.cyan, label: 'running' };
    }
    case 'done':
      return { symbol: '✓', color: ANSI.green, label: 'done' };
    case 'failed':
      return { symbol: '✗', color: ANSI.red, label: 'failed' };
    case 'skipped':
      return { symbol: '–', color: ANSI.yellow, label: 'skipped' };
  }
}

/**
 * Färbt einen Text, sofern Farben aktiv sind.
 */
function colorize(text: string, color: string, noColor: boolean): string {
  if (noColor) return text;
  return `${color}${text}${ANSI.reset}`;
}

/** Erkennt eine vollständige ANSI-CSI-Sequenz am String-Anfang. */
// eslint-disable-next-line no-control-regex
const ANSI_SEQ_AT_START = /^\u001b\[[0-9;?]*[A-Za-z]/;
/** Alle ANSI-CSI-Sequenzen (für die Längenmessung ohne Steuercodes). */
// eslint-disable-next-line no-control-regex
const ANSI_SEQ_ALL = /\u001b\[[0-9;?]*[A-Za-z]/g;

/**
 * Kürzt eine Zeile ANSI-bewusst auf `width` sichtbare Zeichen (mit `…`).
 *
 * Warum: Der Renderer fährt beim Redraw `lastLineCount` Zeilen hoch. Bricht
 * eine zu lange Zeile im Terminal um, belegt sie ZWEI physische Zeilen — die
 * cursor-up-Zählung stimmt nicht mehr und die Darstellung zerreißt. Deshalb
 * darf keine Frame-Zeile breiter als das Terminal sein. ANSI-Sequenzen zählen
 * nicht zur sichtbaren Breite und werden nie mittendrin zerschnitten; bei
 * gekürzten farbigen Zeilen wird ein Reset angehängt (kein Farb-Ausbluten).
 */
export function truncateToWidth(line: string, width: number): string {
  if (width <= 1) return line;
  const plainLength = line.replace(ANSI_SEQ_ALL, '').length;
  if (plainLength <= width) return line;

  let out = '';
  let visible = 0;
  let i = 0;
  let hasAnsi = false;
  while (i < line.length && visible < width - 1) {
    if (line[i] === '\u001b') {
      const m = ANSI_SEQ_AT_START.exec(line.slice(i));
      if (m) {
        out += m[0];
        hasAnsi = true;
        i += m[0].length;
        continue;
      }
    }
    out += line[i];
    visible++;
    i++;
  }
  return `${out}…${hasAnsi ? ANSI.reset : ''}`;
}

/**
 * Baut die Textzeilen für die aktuelle Liste (ohne sie auszugeben).
 * Reine Funktion → einfach testbar.
 *
 * @returns Array von Zeilen (ohne Zeilenumbruch am Ende)
 */
export function buildFrame(rows: TuiRuRow[], options: TuiRenderOptions = {}): string[] {
  const noColor = options.noColor ?? false;
  const lines: string[] = [];

  // Titel
  if (options.title) {
    lines.push(colorize(options.title, ANSI.bold, noColor));
  }

  // Spaltenbreite für RU-Namen (für saubere Ausrichtung).
  const ruWidth = Math.max(3, ...rows.map((r) => r.ru.length));

  // Spinner-Frame nur durchreichen, wenn Animation aktiv ist.
  const spinnerFrame = options.noSpinner ? undefined : options.spinnerFrame;

  // Zeilen pro RU
  for (const row of rows) {
    const v = statusVisual(row.status, row.status === 'running' ? spinnerFrame : undefined);
    const symbol = colorize(v.symbol, v.color, noColor);
    const ruName = row.ru.padEnd(ruWidth);
    const label = colorize(v.label.padEnd(8), v.color, noColor);
    const detail = row.detail ? colorize(`  ${row.detail}`, ANSI.dim, noColor) : '';
    lines.push(`  ${symbol} ${ruName}  ${label}${detail}`);
  }

  // Fußzeile mit Zähler
  const counts = countByStatus(rows);
  const summary = [
    colorize(`${counts.done} done`, ANSI.green, noColor),
    colorize(`${counts.failed} failed`, ANSI.red, noColor),
    colorize(`${counts.skipped} skipped`, ANSI.yellow, noColor),
    colorize(`${counts.running + counts.pending} remaining`, ANSI.gray, noColor),
  ].join('  ');
  lines.push('');
  lines.push(`  ${summary}`);

  return lines;
}

/**
 * Zählt RUs nach Status.
 */
export function countByStatus(rows: TuiRuRow[]): Record<TuiRuStatus, number> {
  const counts: Record<TuiRuStatus, number> = {
    pending: 0,
    running: 0,
    done: 0,
    failed: 0,
    skipped: 0,
  };
  for (const r of rows) counts[r.status]++;
  return counts;
}

/**
 * Live-Renderer: zeichnet die Liste und aktualisiert sie in-place.
 *
 * Verwendung:
 *   const r = new TuiRenderer(rows, { title: '...' });
 *   r.start();
 *   // ... bei jedem Update:
 *   r.update(ru, 'running');
 *   // ... am Ende:
 *   r.stop();
 */
export class TuiRenderer {
  private readonly out: NodeJS.WritableStream;
  private readonly noColor: boolean;
  private readonly title: string | undefined;
  private readonly noSpinner: boolean;
  private readonly plain: boolean;
  private rows: TuiRuRow[];
  private lastLineCount = 0;
  private started = false;
  private spinnerFrame = 0;
  private spinnerTimer: ReturnType<typeof setInterval> | undefined;
  /**
   * Sicherheitsnetz: stellt den Cursor auch bei hartem Prozess-Ende wieder her
   * (z. B. zweites Ctrl+C → `process.exit(130)`), wenn `stop()` nie läuft —
   * sonst bleibt der Terminal-Cursor des Nutzers unsichtbar.
   */
  private exitHandler: (() => void) | undefined;

  constructor(rows: TuiRuRow[], options: TuiRenderOptions = {}) {
    this.rows = rows.map((r) => ({ ...r }));
    this.out = options.out ?? process.stdout;
    this.noColor = options.noColor ?? false;
    this.title = options.title;
    this.noSpinner = options.noSpinner ?? false;
    this.plain = options.plain ?? false;
  }

  /** Zeichnet die erste Version und versteckt den Cursor. */
  start(): void {
    if (this.started) return;
    this.started = true;
    // Frischer Zustand bei (Wieder-)Start: der erste Draw darf NICHT über
    // fremden/alten Inhalt hochfahren.
    this.lastLineCount = 0;
    // Im Plain-Modus (kein TTY) wird nicht live gezeichnet — erst am Ende.
    if (this.plain) return;
    if (!this.noColor) {
      this.out.write(ANSI.hideCursor);
      this.exitHandler = (): void => {
        this.out.write(ANSI.showCursor);
      };
      process.on('exit', this.exitHandler);
    }
    this.draw();
    this.syncSpinnerTimer();
  }

  /**
   * Aktualisiert den Status (und optional Detail) einer RU und zeichnet neu.
   */
  update(ru: string, status: TuiRuStatus, detail?: string): void {
    const row = this.rows.find((r) => r.ru === ru);
    if (row) {
      row.status = status;
      if (detail !== undefined) row.detail = detail;
    }
    if (!this.started) return;
    if (this.plain) {
      // Plain-Modus: pro abgeschlossener RU eine einzelne, fortlaufende Zeile.
      if (row && status !== 'running' && status !== 'pending') {
        const detailText = row.detail ? ` — ${row.detail}` : '';
        this.out.write(`  ${row.ru}: ${status}${detailText}\n`);
      }
      return;
    }
    this.draw();
    // Timer-Zustand anpassen: ggf. starten (neue running-RU) oder
    // stoppen (keine running-RU mehr übrig).
    this.syncSpinnerTimer();
  }

  /** Beendet das Live-Rendering, stoppt den Spinner, zeigt den Cursor wieder. */
  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.stopSpinnerTimer();
    if (this.exitHandler) {
      process.removeListener('exit', this.exitHandler);
      this.exitHandler = undefined;
    }
    if (this.plain) {
      // Im Plain-Modus am Ende einmalig den finalen Frame ausgeben.
      const frame = buildFrame(this.rows, {
        noColor: this.noColor,
        noSpinner: true,
        ...(this.title !== undefined ? { title: this.title } : {}),
      });
      this.out.write(`${frame.join('\n')}\n`);
      return;
    }
    if (!this.noColor) this.out.write(ANSI.showCursor);
  }

  /**
   * Startet oder stoppt den Spinner-Timer abhängig davon, ob aktuell
   * mindestens eine RU `running` ist. So läuft der Timer nur, wenn er
   * gebraucht wird (CPU-schonend) und stoppt automatisch am Ende.
   */
  private syncSpinnerTimer(): void {
    if (this.noSpinner) return;
    const hasRunning = this.rows.some((r) => r.status === 'running');
    if (hasRunning && this.spinnerTimer === undefined) {
      this.spinnerTimer = setInterval(() => {
        this.spinnerFrame++;
        this.draw();
      }, SPINNER_INTERVAL_MS);
      // Timer soll den Prozess-Exit nicht blockieren.
      if (typeof this.spinnerTimer.unref === 'function') this.spinnerTimer.unref();
    } else if (!hasRunning && this.spinnerTimer !== undefined) {
      this.stopSpinnerTimer();
    }
  }

  /** Stoppt den Spinner-Timer, falls aktiv. */
  private stopSpinnerTimer(): void {
    if (this.spinnerTimer !== undefined) {
      clearInterval(this.spinnerTimer);
      this.spinnerTimer = undefined;
    }
  }

  /** Liefert eine Kopie des aktuellen Zustands (für Tests/Debug). */
  getRows(): TuiRuRow[] {
    return this.rows.map((r) => ({ ...r }));
  }

  /**
   * Interne Zeichenroutine: fährt den Cursor hoch über die zuletzt
   * gezeichneten Zeilen und überschreibt sie mit dem neuen Frame.
   */
  private draw(): void {
    const frame = buildFrame(this.rows, {
      noColor: this.noColor,
      noSpinner: this.noSpinner,
      spinnerFrame: this.spinnerFrame,
      ...(this.title !== undefined ? { title: this.title } : {}),
    });

    // Terminalbreite bei JEDEM Draw frisch lesen (Resize während des Laufs):
    // Zeilen breiter als das Terminal würden umbrechen und die cursor-up-
    // Zeilenzahl unbrauchbar machen → ANSI-bewusst kürzen.
    const columns = (this.out as Partial<NodeJS.WriteStream>).columns;

    // Cursor hochfahren und alte Zeilen löschen.
    let output = '';
    if (this.lastLineCount > 0) {
      output += ANSI.cursorUp(this.lastLineCount);
    }
    for (const line of frame) {
      const fitted = typeof columns === 'number' ? truncateToWidth(line, columns) : line;
      output += `${ANSI.clearLine}${ANSI.lineStart}${fitted}\n`;
    }

    this.out.write(output);
    this.lastLineCount = frame.length;
  }
}
