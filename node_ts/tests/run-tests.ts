import { run } from 'node:test';
import { globSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const testFiles = globSync('tests/**/*.test.ts').map(f => pathToFileURL(resolve(f)).href);

run({
  files: testFiles,
})
.on('test:fail', () => {
  process.exitCode = 1;
})
.compose(new (await import('node:test/reporters')).Spec())
.pipe(process.stdout);
