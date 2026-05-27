#!/usr/bin/env node
/**
 * GitBulk CLI - Einstiegspunkt
 *
 * Wird über das `gitbulk`-Binary aufgerufen (siehe package.json `bin`).
 * Im Dev-Modus via `npm run dev` ausführbar.
 */

// TODO: Commander-basierte CLI implementieren (nächster Schritt).

async function main(): Promise<void> {
  console.log('GitBulk v0.1.0 — CLI noch nicht implementiert.');
  console.log('Projekt-Setup steht. Nächster Schritt: Config-Loader & CLI.');
}

main().catch((error: unknown) => {
  console.error('Unerwarteter Fehler:', error);
  process.exit(1);
});
