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

/**
 * Erstellt einen Mock für das readline-Interface.
 */
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
 * Helfer: Mockt stdout/stderr für die Testausführung.
 */
function captureLogs(fn: () => void): { stdout: string; stderr: string } {
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
    fn();
  } finally {
    process.stdout.write = origStdout;
    process.stderr.write = origStderr;
  }

  return { stdout, stderr };
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

      const logs = captureLogs(() => {
        /* empty */
      });

      const result = await promptUntilValid(rl as Interface, 'Enter RUs:', validateRuList);

      assert.deepEqual(result, ['repo-a']);
    });

    it('writes error to stderr on validation failure', async () => {
      const { rl } = createMockReadline(['', 'valid-ticket']);

      let stderrOutput = '';
      const origStderr = process.stderr.write;
      process.stderr.write = ((chunk: any) => {
        stderrOutput += typeof chunk === 'string' ? chunk : chunk.toString();
        return true;
      }) as any;

      try {
        await promptUntilValid(rl as Interface, 'Ticket:', validateTicket);
        assert.match(stderrOutput, /Error/);
      } finally {
        process.stderr.write = origStderr;
      }
    });

    it('handles multiple retries', async () => {
      const { rl } = createMockReadline(['', ' ', '   ', 'valid-msg']);

      const result = await promptUntilValid(rl as Interface, 'Message:', validateMessage);

      assert.equal(result, 'valid-msg');
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

      const result = await promptUntilValid(rl as Interface, 'Accept?', validateYesNo);
      assert.equal(result, true);
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

      let stdoutOutput = '';
      const origStdout = process.stdout.write;
      process.stdout.write = ((chunk: any) => {
        stdoutOutput += typeof chunk === 'string' ? chunk : chunk.toString();
        return true;
      }) as any;

      try {
        const confirmed = await confirmConfig(rl as Interface, config);
        assert.equal(confirmed, true);
        assert.match(stdoutOutput, /Configuration Summary/);
        assert.match(stdoutOutput, /repo-a, repo-b/);
        assert.match(stdoutOutput, /AKB-1234/);
        assert.match(stdoutOutput, /feature-xyz/);
      } finally {
        process.stdout.write = origStdout;
      }
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

      const origStdout = process.stdout.write;
      process.stdout.write = (() => true) as any;

      try {
        const confirmed = await confirmConfig(rl as Interface, config);
        assert.equal(confirmed, false);
      } finally {
        process.stdout.write = origStdout;
      }
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

      let stdoutOutput = '';
      const origStdout = process.stdout.write;
      process.stdout.write = ((chunk: any) => {
        stdoutOutput += typeof chunk === 'string' ? chunk : chunk.toString();
        return true;
      }) as any;

      try {
        await confirmConfig(rl as Interface, config);
        assert.match(stdoutOutput, /PR on error:\s+No/);
      } finally {
        process.stdout.write = origStdout;
      }
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

      let stdoutOutput = '';
      const origStdout = process.stdout.write;
      process.stdout.write = ((chunk: any) => {
        stdoutOutput += typeof chunk === 'string' ? chunk : chunk.toString();
        return true;
      }) as any;

      try {
        await confirmConfig(rl as Interface, config);
        assert.match(stdoutOutput, /PR on error:\s+Yes/);
      } finally {
        process.stdout.write = origStdout;
      }
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

      const origStdout = process.stdout.write;
      process.stdout.write = (() => true) as any;

      try {
        const confirmed = await confirmConfig(rl as Interface, config);
        assert.equal(confirmed, false);
      } finally {
        process.stdout.write = origStdout;
      }
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

      let stdoutOutput = '';
      const origStdout = process.stdout.write;
      process.stdout.write = ((chunk: any) => {
        stdoutOutput += typeof chunk === 'string' ? chunk : chunk.toString();
        return true;
      }) as any;

      try {
        const confirmed = await confirmConfig(rl as Interface, config);
        assert.equal(confirmed, true);
        assert.match(stdoutOutput, /repo-a, repo-b, repo-c/);
        assert.match(stdoutOutput, /ABC-999/);
      } finally {
        process.stdout.write = origStdout;
      }
    });
  });
});


