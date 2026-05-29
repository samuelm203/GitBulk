/**
 * Operations-Fundament für GitBulk.
 *
 * Eine "Operation" ist ein wiederverwendbarer, deklarativer Code-Change-
 * Baustein (z. B. "füge eine Maven-Abhängigkeit hinzu", "ersetze eine Datei").
 * Operationen sind die Alternative zu einem frei geschriebenen Skript: Statt
 * `script: ./change.sh` kann die Config eine oder mehrere `operations:`
 * enthalten, die GitBulk im Repo-Verzeichnis ausführt.
 *
 * Designziele:
 *   - **Erweiterbar**: Eine neue Operation = ein Modul + eine Registrierung.
 *   - **Verkettbar**: Mehrere Operationen laufen nacheinander pro Repo.
 *   - **Typsicher**: Jede Operation bringt ihr eigenes Zod-Schema für ihre
 *     Parameter mit; ungültige Config wird früh abgewiesen.
 *   - **Konsistent mit Skripten**: Das Ergebnis lässt sich auf denselben
 *     Exit-Code-/Diff-Mechanismus abbilden, den `executeCodeChange` nutzt.
 */

import type { z } from 'zod';

/**
 * Kontext, den jede Operation beim Ausführen erhält.
 */
export interface OperationContext {
  /** Absoluter Pfad zum Wurzelverzeichnis des aktuellen Repos. */
  repoDir: string;
  /** Name der aktuellen RU (Repository). */
  ru: string;
  /** Ticket-Identifier aus der Config. */
  ticket: string;
  /** Voll-qualifizierter Feature-Branch-Name. */
  branch: string;
  /** Quell-Branch (z. B. master). */
  sourceBranch: string;
}

/**
 * Ergebnis einer einzelnen Operation.
 */
export interface OperationResult {
  /** Wurde tatsächlich etwas an den Dateien geändert? */
  changed: boolean;
  /** Menschenlesbare Kurzbeschreibung des Ergebnisses (fürs Log). */
  message: string;
  /**
   * Fehlermeldung, falls die Operation fehlschlug. Ist dies gesetzt, gilt die
   * Operation als gescheitert (entspricht Exit-Code != 0 bei einem Skript).
   */
  error?: string;
}

/**
 * Eine ausführbare Operation.
 *
 * @typeParam P - Der (validierte) Parameter-Typ dieser Operation.
 */
export interface Operation<P = unknown> {
  /** Eindeutiger Typ-Name, wie er in der Config unter `type:` steht. */
  readonly type: string;
  /** Kurze Beschreibung (für den interaktiven Generator / die Hilfe). */
  readonly description: string;
  /**
   * Zod-Schema, das die Parameter dieser Operation validiert.
   *
   * Der dritte Generic-Parameter (`unknown` als Input) erlaubt Schemas mit
   * `.default()`/`.optional()`, deren geparster Output-Typ `P` strikter ist
   * als ihr Eingabe-Typ — typische Zod-Konstellation.
   */
  readonly schema: z.ZodType<P, z.ZodTypeDef, unknown>;
  /**
   * Führt die Operation im Repo aus. Sollte NICHT werfen für normale
   * Fehlerfälle — stattdessen `{ changed: false, error: '...' }` zurückgeben.
   * Ein geworfener Fehler wird vom Aufrufer abgefangen und wie `error`
   * behandelt, aber sauberes Result-Reporting ist vorzuziehen.
   */
  apply(params: P, ctx: OperationContext): Promise<OperationResult> | OperationResult;
}

/**
 * Registry aller bekannten Operationen, indexiert nach `type`.
 *
 * Neue Operationen werden über `registerOperation` hinzugefügt — typischerweise
 * beim Modul-Import in `operations/index.ts`. So bleibt das Hinzufügen einer
 * Operation auf eine Datei + eine Registrierungszeile beschränkt.
 */
const registry = new Map<string, Operation<never>>();

/**
 * Registriert eine Operation. Wirft, wenn der Typ-Name bereits belegt ist
 * (verhindert versehentliche Duplikate).
 */
export function registerOperation<P>(op: Operation<P>): void {
  if (registry.has(op.type)) {
    throw new Error(`Operation type "${op.type}" is already registered`);
  }
  // Intern speichern wir ohne den konkreten Parameter-Typ (type-erased).
  registry.set(op.type, op as unknown as Operation<never>);
}

/**
 * Liefert die registrierte Operation für einen Typ, oder `undefined`.
 */
export function getOperation(type: string): Operation<never> | undefined {
  return registry.get(type);
}

/**
 * Liefert alle registrierten Operation-Typen (für Hilfe/Generator/Validierung).
 */
export function listOperationTypes(): string[] {
  return [...registry.keys()].sort();
}

/**
 * Liefert alle registrierten Operationen (für den interaktiven Generator).
 */
export function listOperations(): Array<{ type: string; description: string }> {
  return [...registry.values()]
    .map((op) => ({ type: op.type, description: op.description }))
    .sort((a, b) => a.type.localeCompare(b.type));
}

/**
 * NUR FÜR TESTS: leert die Registry. Sollte im Produktivcode nicht nötig sein.
 */
export function _clearRegistryForTests(): void {
  registry.clear();
}
