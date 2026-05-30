/**
 * Gemeinsame JSON-Helfer für die json-/npm-Operationen.
 *
 * Ziel: vorhandene Dateien möglichst schonend bearbeiten (Einrückung
 * beibehalten) und Werte deterministisch setzen/vergleichen.
 */

/**
 * Ermittelt die Einrückung einer JSON-Datei aus ihrem Text.
 * Gibt die Anzahl Leerzeichen zurück, `'\t'` bei Tabs, oder 2 als Default.
 */
export function detectJsonIndent(text: string): number | string {
  const match = text.match(/\n([ \t]+)\S/);
  if (!match || match[1] === undefined) return 2;
  const ws = match[1];
  if (ws.includes('\t')) return '\t';
  return ws.length;
}

/**
 * Interpretiert einen String-Wert als JSON, wenn möglich (z. B. `"true"` →
 * `true`, `"42"` → `42`, `'"x"'` → `"x"`), sonst als rohen String.
 * So lassen sich auch nicht-String-Werte über eine string-Eingabe setzen.
 */
export function coerceJsonValue(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/** Liefert den Wert an einem Dot-Pfad (z. B. `scripts.build`) oder `undefined`. */
export function getByDotPath(obj: unknown, dotPath: string): unknown {
  const keys = dotPath.split('.');
  let current: unknown = obj;
  for (const key of keys) {
    if (typeof current !== 'object' || current === null) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/**
 * Setzt den Wert an einem Dot-Pfad und legt fehlende Zwischenobjekte an.
 * Mutiert `obj` in place.
 */
export function setByDotPath(obj: Record<string, unknown>, dotPath: string, value: unknown): void {
  const keys = dotPath.split('.');
  let current: Record<string, unknown> = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i] as string;
    const next = current[key];
    if (typeof next !== 'object' || next === null || Array.isArray(next)) {
      current[key] = {};
    }
    current = current[key] as Record<string, unknown>;
  }
  current[keys[keys.length - 1] as string] = value;
}
