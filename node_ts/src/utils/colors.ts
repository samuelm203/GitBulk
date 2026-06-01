/**
 * Zero-Dependency-Farbhelfer (Ersatz für `chalk`).
 *
 * Jede Funktion umschließt ihren Text bedingungslos mit ANSI-Escape-Codes.
 * Ob Farbe genutzt wird, entscheiden — wie bisher mit chalk — die Aufrufer
 * über ihr `useColor`/`--no-color`-Flag (`useColor ? colors.x(s) : s`).
 *
 * Bewusst minimal: nur die im Projekt tatsächlich genutzten Stile. Das
 * ESC-Zeichen wird aus seinem Code-Point (27) gebaut, damit keine literalen
 * Steuerzeichen im Quelltext stehen.
 */

const ESC = String.fromCharCode(27);
const RESET = `${ESC}[0m`;

/** Baut eine Färbe-Funktion aus den SGR-Codes (z. B. "31" oder "1;31"). */
function sgr(code: string): (s: string) => string {
  const open = `${ESC}[${code}m`;
  return (s: string): string => `${open}${s}${RESET}`;
}

export const bold = sgr('1');
export const dim = sgr('2');
export const red = sgr('31');
export const green = sgr('32');
export const yellow = sgr('33');
export const magenta = sgr('35');
export const cyan = sgr('36');
export const gray = sgr('90');

/** Kombiniert fett + rot (Ersatz für `chalk.red.bold`). */
export const redBold = sgr('1;31');
