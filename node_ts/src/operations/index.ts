/**
 * Zentraler Einstiegspunkt für alle GitBulk-Operationen.
 *
 * Jede Operation registriert sich selbst beim Import (Seiteneffekt von
 * `registerOperation` im jeweiligen Modul). Wer Operationen nutzen will,
 * importiert diese Datei einmal — dadurch ist die Registry vollständig gefüllt.
 *
 * Eine neue Operation hinzufügen:
 *   1. Neue Datei `src/operations/<name>.ts` anlegen (analog zu den anderen).
 *   2. Hier importieren (die Zeile reicht — der Import löst die Registrierung aus).
 */

import './maven-add-dependency.js';
import './add-file.js';
import './replace-file.js';
import './delete-file.js';
import './regex-replace.js';

// Re-Export der Registry-API für bequemen Zugriff.
export {
  getOperation,
  listOperationTypes,
  listOperations,
  type Operation,
  type OperationContext,
  type OperationResult,
} from './types.js';
