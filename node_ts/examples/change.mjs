#!/usr/bin/env node
// ──────────────────────────────────────────────────────────────
// GitBulk — Beispiel-Code-Change-Skript (JavaScript / .mjs)
// ──────────────────────────────────────────────────────────────
//
// GitBulk führt dieses Skript MIT dem Repository als Arbeitsverzeichnis aus.
// Es darf NUR Dateien ändern — git add / commit / push übernimmt GitBulk.
//   - Exit 0 + Diff      → Commit + PR
//   - Exit != 0 + Diff   → Commit "ERROR WHILE CODE CHANGE", PR nur bei createPrOnError
//   - kein Diff          → kein PR, Branch wird gelöscht
//
// Verfügbare Umgebungsvariablen (von GitBulk gesetzt):
//   GITBULK_RU, GITBULK_TICKET, GITBULK_BRANCH, GITBULK_SOURCE_BRANCH
//
// Nutzung in der Config:  script: ./examples/change.mjs

import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const ru = process.env.GITBULK_RU ?? 'unknown';
const ticket = process.env.GITBULK_TICKET ?? '';
console.log(`[change] Bearbeite ${ru} (Ticket ${ticket})`);

// Beispiel: package.json-Version bumpen, falls vorhanden.
if (existsSync('package.json')) {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  const [major, minor, patch] = String(pkg.version ?? '0.0.0').split('.').map(Number);
  pkg.version = `${major}.${minor}.${(patch ?? 0) + 1}`;
  writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
  console.log(`[change] Version → ${pkg.version}`);
} else {
  console.log('[change] keine package.json — nichts zu tun');
}

// Kein expliziter Exit nötig → Exit-Code 0 (Erfolg).
