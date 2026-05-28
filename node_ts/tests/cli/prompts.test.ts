/**
 * Unit-Tests für cli/prompts.ts.
 *
 * Mockt die readline-Interface, um Benutzereingaben und Validierung zu testen.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Interface } from 'node:readline/promises';

import {
  promptUntilValid,
  confirmConfig,
  type InteractiveInputResult,
} from '../../src/cli/prompts.js';
import {
  validateRuList,
  validateYesNo,
  validateTicket,
  validateMessage,
} from '../../src/utils/validators.js';
function createMockReadline(answers: string[]): {
  rl: Partial<Interface> & { answerIndex: number };
  reset: () => void;
} {
  let answerIndex = 0;

  const rl: any = {
    answerIndex: 0,
    question: async (prompt: string) => {
      if (answerIndex >= answers.length) {
        throw new Error(`No answer provided for prompt: "${prompt}"`);
      }
      const answer = answers[answerIndex++];
      return answer;
    },
    close: () => {
      answerIndex = 0;
    },
  };

  return {
    rl,
    reset: () => {
      answerIndex = 0;
      rl.answerIndex = 0;
    },
  };
}

/**
 * Helfer: Mockt stdout/stderr für die Testausführung (jetzt async-fähig).
 */
async function captureLogs(fn: () => Promise<void> | void): Promise<{ stdout: string; stderr: string }> {
  const origStdout = process.stdout.write;
  const origStderr = process.stderr.write;

  let stdout = '';
  let stderr = '';

  process.stdout.write = ((chunk: any) => {
    stdout += typeof chunk === 'string' ? chunk : chunk.toString();
    return true;
  }) as any;

  process.stderr.write = ((chunk: any) => {
    stderr += typeof chunk === 'string' ? chunk : chunk.toString();
    return true;
  }) as any;

  try {
    await fn();
  } finally {
    process.stdout.write = origStdout;
    process.stderr.write = origStderr;
  }

  const stripAnsi = (str: string) =>
    str.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '');

  return { stdout: stripAnsi(stdout), stderr: stripAnsi(stderr) };
}

describe('cli/prompts.ts', () => {
  describe('promptUntilValid', () => {
    it('returns value on valid input', async () => {
      const { rl } = createMockReadline(['repo-a,repo-b']);

      const result = await promptUntilValid(rl as Interface, 'Enter RUs:', validateRuList);

      assert.deepEqual(result, ['repo-a', 'repo-b']);
    });

    it('retries on invalid input and succeeds', async () => {
      const { rl } = createMockReadline(['', 'repo-a']); // Leere RU-Liste wird abgelehnt

      let result;
      const logs = await captureLogs(async () => {
        result = await promptUntilValid(rl as Interface, 'Enter RUs:', validateRuList);
      });

      assert.deepEqual(result, ['repo-a']);
      assert.match(logs.stderr, /Error/);
    });

    it('writes error to stderr on validation failure', async () => {
      const { rl } = createMockReadline(['', 'valid-ticket']);

      const logs = await captureLogs(async () => {
        await promptUntilValid(rl as Interface, 'Ticket:', validateTicket);
      });

      assert.match(logs.stderr, /Error/);
    });

    it('handles multiple retries', async () => {
      const { rl } = createMockReadline(['', ' ', '   ', 'valid-msg']);

      let result;
      const logs = await captureLogs(async () => {
        result = await promptUntilValid(rl as Interface, 'Message:', validateMessage);
      });

      assert.equal(result, 'valid-msg');
      assert.match(logs.stderr, /Error/);
    });

    it('accepts Y/N boolean validation', async () => {
      const { rl } = createMockReadline(['yes', 'Y']);

      const result1 = await promptUntilValid(rl as Interface, 'Accept?', validateYesNo);
      assert.equal(result1, true);

      // Reset für nächsten Test
      const { rl: rl2 } = createMockReadline(['no']);
      const result2 = await promptUntilValid(rl2 as Interface, 'Accept?', validateYesNo);
      assert.equal(result2, false);
    });

    it('rejects invalid Y/N and retries', async () => {
      const { rl } = createMockReadline(['maybe', 'nope', 'y']);

      let result;
      const logs = await captureLogs(async () => {
        result = await promptUntilValid(rl as Interface, 'Accept?', validateYesNo);
      });

      assert.equal(result, true);
      assert.match(logs.stderr, /Error/);
    });
  });

  describe('confirmConfig', () => {
    it('displays configuration summary and confirms', async () => {
      const config: InteractiveInputResult = {
        rus: ['repo-a', 'repo-b'],
        ticket: 'AKB-1234',
        branch: 'feature-xyz',
        script: '/path/to/script.js',
        commitMessage: 'Fix: updated config',
        prSummary: 'Updated configuration',
        createPrOnError: true,
      };

      const { rl } = createMockReadline(['Y']);

      let confirmed;
      const logs = await captureLogs(async () => {
        confirmed = await confirmConfig(rl as Interface, config);
      });

      assert.equal(confirmed, true);
      assert.match(logs.stdout, /Configuration Summary/);
      assert.match(logs.stdout, /repo-a, repo-b/);
      assert.match(logs.stdout, /AKB-1234/);
      assert.match(logs.stdout, /feature-xyz/);
    });

    it('returns false when user rejects confirmation', async () => {
      const config: InteractiveInputResult = {
        rus: ['repo-a'],
        ticket: 'AKB-1234',
        branch: 'feature',
        script: '/path/to/script.js',
        commitMessage: 'Fix',
        prSummary: 'Summary',
        createPrOnError: false,
      };

      const { rl } = createMockReadline(['N']);

      let confirmed;
      await captureLogs(async () => {
        confirmed = await confirmConfig(rl as Interface, config);
      });

      assert.equal(confirmed, false);
    });

    it('shows PR on error status correctly', async () => {
      const config: InteractiveInputResult = {
        rus: ['repo-a'],
        ticket: 'AKB-1234',
        branch: 'feature',
        script: '/path/to/script.js',
        commitMessage: 'Fix',
        prSummary: 'Summary',
        createPrOnError: false,
      };

      const { rl } = createMockReadline(['Y']);

      const logs = await captureLogs(async () => {
        await confirmConfig(rl as Interface, config);
      });

      assert.match(logs.stdout, /PR on error:\s+No/);
    });

    it('shows PR on error as Yes when true', async () => {
      const config: InteractiveInputResult = {
        rus: ['repo-a'],
        ticket: 'AKB-1234',
        branch: 'feature',
        script: '/path/to/script.js',
        commitMessage: 'Fix',
        prSummary: 'Summary',
        createPrOnError: true,
      };

      const { rl } = createMockReadline(['Y']);

      const logs = await captureLogs(async () => {
        await confirmConfig(rl as Interface, config);
      });

      assert.match(logs.stdout, /PR on error:\s+Yes/);
    });

    it('rejects invalid Y/N and retries', async () => {
      const config: InteractiveInputResult = {
        rus: ['repo-a'],
        ticket: 'AKB-1234',
        branch: 'feature',
        script: '/path/to/script.js',
        commitMessage: 'Fix',
        prSummary: 'Summary',
        createPrOnError: false,
      };

      const { rl } = createMockReadline(['invalid', 'maybe', 'n']);

      let confirmed;
      const logs = await captureLogs(async () => {
        confirmed = await confirmConfig(rl as Interface, config);
      });

      assert.equal(confirmed, false);
      assert.match(logs.stderr, /Error/);
    });

    it('handles multiple RUs in configuration summary', async () => {
      const config: InteractiveInputResult = {
        rus: ['repo-a', 'repo-b', 'repo-c'],
        ticket: 'ABC-999',
        branch: 'my-feature',
        script: '/path/to/test.sh',
        commitMessage: 'Multiple repos update',
        prSummary: 'Feature for 3 repos',
        createPrOnError: true,
      };

      const { rl } = createMockReadline(['YES']);

      let confirmed;
      const logs = await captureLogs(async () => {
        confirmed = await confirmConfig(rl as Interface, config);
      });

      assert.equal(confirmed, true);
      assert.match(logs.stdout, /repo-a, repo-b, repo-c/);
      assert.match(logs.stdout, /ABC-999/);
    });
  });
});


