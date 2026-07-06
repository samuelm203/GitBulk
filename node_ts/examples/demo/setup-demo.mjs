#!/usr/bin/env node
/**
 * GitBulk-Demo-Setup — baut einen isolierten, gefahrlosen Demo-Workspace:
 *
 *   - 3 Mini-Repos (service-a/b/c) mit lokalen Bare-"Remotes" und package.json
 *   - eine fertige Demo-Config (Dry-Run, add-file + npm-add-dependency)
 *
 * Nichts verlässt den Rechner: `dryRun: true` überspringt Push + PR-API, als
 * Token genügt ein Dummy-Wert, und GITBULK_HOME zeigt in den Demo-Ordner —
 * die echten Credentials unter ~/.gitbulk werden nie angefasst. Dry-Run räumt
 * die Repos nach jedem Lauf auf → die Demo ist beliebig oft wiederholbar.
 *
 * Verwendung:
 *   node examples/demo/setup-demo.mjs [zielordner]
 *   (Default-Ziel: <tmp>/gitbulk-demo — wird vorher gelöscht!)
 */

import { execSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const demoDir = resolve(process.argv[2] ?? join(tmpdir(), 'gitbulk-demo'));
const services = ['service-a', 'service-b', 'service-c'];

function git(args, cwd) {
  execSync(`git ${args}`, { cwd, stdio: 'pipe' });
}

console.log(`Setting up the GitBulk demo workspace in ${demoDir} …`);
rmSync(demoDir, { recursive: true, force: true });
mkdirSync(join(demoDir, 'remotes'), { recursive: true });

for (const name of services) {
  const remote = join(demoDir, 'remotes', `${name}.git`);
  const work = join(demoDir, name);

  mkdirSync(remote, { recursive: true });
  git('init --bare -q --initial-branch=main', remote);
  git(`clone -q "${remote}" "${work}"`, demoDir);
  git('config user.email "demo@example.com"', work);
  git('config user.name "GitBulk Demo"', work);
  writeFileSync(
    join(work, 'package.json'),
    `${JSON.stringify({ name, version: '1.0.0', dependencies: {} }, null, 2)}\n`,
  );
  git('add -A', work);
  git(`commit -q -m "init ${name}"`, work);
  git('push -q -u origin main', work);
  console.log(`  ✓ ${name} (local remote: remotes/${name}.git)`);
}

// Pfad mit Forward-Slashes — portabel in YAML (auch unter Windows).
const workspaceDir = demoDir.split('\\').join('/');
const config = `# GitBulk-Demo-Config — erzeugt von examples/demo/setup-demo.mjs.
# dryRun: true → kein Push, keine PR-API. Beliebig oft wiederholbar.
rus: [service-a, service-b, service-c]
ticket: DEMO-1
branch: gitbulk-demo
sourceBranch: main
workspaceDir: ${workspaceDir}
commitMessage: "add lodash + NOTES.md"
prSummary: "DEMO: Bulk-Change ueber alle Services"
createPrOnError: false
dryRun: true
concurrency: 3
operations:
  - type: add-file
    path: NOTES.md
    content: "Angelegt von der GitBulk-Demo."
  - type: npm-add-dependency
    name: lodash
    version: "^4.17.21"
prPlatform: github
github:
  owner: demo-org
  targetBranch: main
  reviewers: []
`;
const configPath = join(demoDir, 'gitbulk.demo.yaml');
writeFileSync(configPath, config);
console.log(`  ✓ gitbulk.demo.yaml`);

const isWin = process.platform === 'win32';
const setVar = (name, value) =>
  isWin ? `$env:${name} = '${value}'` : `export ${name}='${value}'`;

console.log(`
Demo ready! Next steps (${isWin ? 'PowerShell' : 'bash'}):

  ${setVar('GITBULK_GITHUB_TOKEN', 'demo-not-real')}   # Dummy — Dry-Run ruft nie die API auf
  ${setVar('GITBULK_HOME', join(demoDir, '.gitbulk'))}   # isoliert die echten Credentials

  npx --yes @samuelm203/gitbulk --gui --config "${configPath}" --dry-run
  npx --yes @samuelm203/gitbulk --tui --config "${configPath}" --dry-run
  npx --yes @samuelm203/gitbulk --config "${configPath}" --dry-run --report demo-report.json

Cleanup afterwards: delete ${demoDir}
`);
