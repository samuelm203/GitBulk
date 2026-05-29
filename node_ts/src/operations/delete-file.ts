/**
 * Operation: delete-file
 *
 * Löscht eine Datei im Repo.
 *
 * Verhalten:
 *   - Datei fehlt        → changed: false (idempotent; nichts zu tun).
 *   - Ziel ist Verzeichnis → error (delete-file löscht bewusst keine Verzeichnisse).
 *   - Sonst              → löscht sie, changed: true.
 */

import { existsSync, rmSync, statSync } from 'node:fs';
import { z } from 'zod';

import { registerOperation, type Operation, type OperationContext, type OperationResult } from './types.js';
import { resolveInRepo } from './paths.js';

const schema = z.object({
  /** Repo-relativer Pfad der zu löschenden Datei. */
  path: z.string().min(1, 'path must not be empty'),
});

type DeleteFileParams = z.infer<typeof schema>;

const operation: Operation<DeleteFileParams> = {
  type: 'delete-file',
  description: 'Delete a file (no-op if it is already gone)',
  schema,

  apply(params: DeleteFileParams, ctx: OperationContext): OperationResult {
    const resolved = resolveInRepo(ctx.repoDir, params.path);
    if (!resolved.ok) {
      return { changed: false, message: resolved.error, error: resolved.error };
    }
    const file = resolved.path;

    if (!existsSync(file)) {
      return { changed: false, message: `${params.path} does not exist — nothing to delete.` };
    }

    if (statSync(file).isDirectory()) {
      const error = `${params.path} is a directory — delete-file refuses to delete directories.`;
      return { changed: false, message: error, error };
    }

    rmSync(file);
    return { changed: true, message: `Deleted ${params.path}` };
  },

  generateScript(params: DeleteFileParams): string {
    const path = JSON.stringify(params.path);
    return [
      `const target = join(repoDir, ${path});`,
      `if (!existsSync(target)) log(${path} + ' not present — nothing to delete');`,
      `else if (statSync(target).isDirectory()) log(${path} + ' is a directory — skipped');`,
      `else { rmSync(target); log('deleted ' + ${path}); }`,
    ].join('\n');
  },
};

registerOperation(operation);

export default operation;
