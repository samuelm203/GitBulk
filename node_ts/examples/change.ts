// ──────────────────────────────────────────────────────────────
// GitBulk — Beispiel-Code-Change-Skript (TypeScript / .ts)
// ──────────────────────────────────────────────────────────────
//
// Läuft über tsx (falls im Ziel-Repo installiert, Node 20+) oder über Nodes
// eingebautes Type-Stripping (Node >= 22.6). GitBulk wählt die Runtime
// automatisch. Auf Node < 22.6 ohne tsx erscheint eine klare Fehlermeldung.
//
// Wie bei .mjs: NUR Dateien ändern; git add/commit/push macht GitBulk.
// Env-Variablen: GITBULK_RU, GITBULK_TICKET, GITBULK_BRANCH, GITBULK_SOURCE_BRANCH
//
// Nutzung in der Config:  script: ./examples/change.ts

import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const ru: string = process.env.GITBULK_RU ?? 'unknown';
const branch: string = process.env.GITBULK_BRANCH ?? '';
console.log(`[change] Bearbeite ${ru} auf Branch ${branch}`);

// Beispiel: eine Marker-Zeile in einer README ergänzen (idempotent).
const file = 'README.md';
if (existsSync(file)) {
  const marker = `<!-- touched by ${ru} -->`;
  const current: string = readFileSync(file, 'utf8');
  if (!current.includes(marker)) {
    writeFileSync(file, `${current.trimEnd()}\n\n${marker}\n`);
    console.log('[change] Marker ergänzt');
  } else {
    console.log('[change] Marker bereits vorhanden — übersprungen');
  }
} else {
  console.log('[change] keine README.md — nichts zu tun');
}
