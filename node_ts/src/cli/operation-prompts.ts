/**
 * Geteilte interaktive Prompts zum Zusammenstellen einer Operationen-Kette.
 *
 * Wird sowohl vom `gitbulk init`-Generator (`cli/init.ts`) als auch vom rein
 * interaktiven Lauf-Modus (`cli/prompts.ts`) genutzt. Die Parameter jeder
 * Operation werden aus ihrem Zod-Schema abgeleitet (`describeOperationParams`),
 * sodass neue Operationen ohne Änderung hier abfragbar sind.
 */

import type { Interface } from 'node:readline/promises';
import { stdout as output } from 'node:process';

import * as colors from '../utils/colors.js';
import { listOperations, getOperation } from '../operations/index.js';
import { describeOperationParams, type ParamSpec } from './operation-introspect.js';
import { validateYesNo } from '../utils/validators.js';

/** Intern gesammelte Operation: Typ + geparste Parameter (inkl. Defaults). */
export interface CollectedOp {
  type: string;
  params: Record<string, unknown>;
}

/** Validator für eine "1 oder 2"-Auswahl (für Eingangsfragen). */
export function chooseOneOrTwo(
  raw: string,
): { ok: true; value: '1' | '2' } | { ok: false; error: string } {
  const t = raw.trim();
  return t === '1' || t === '2'
    ? { ok: true, value: t }
    : { ok: false, error: 'Please enter 1 or 2.' };
}

/**
 * Fragt einen einzelnen Operation-Parameter ab.
 * @returns den Wert, oder `undefined` wenn das (optionale) Feld übersprungen wird.
 */
async function promptParam(rl: Interface, spec: ParamSpec): Promise<unknown> {
  const def =
    spec.defaultValue !== undefined ? ` ${colors.gray(`[default: ${String(spec.defaultValue)}]`)}` : '';
  const opt = spec.required ? '' : colors.gray(' (optional)');

  if (spec.kind === 'boolean') {
    const hint = spec.required ? '(Y/N)' : '(Y/N, blank = default)';
    for (;;) {
      const raw = (await rl.question(colors.cyan(`  ${spec.name} ${hint}${def}: `))).trim();
      if (raw === '') {
        return spec.required ? promptRetry(rl, spec) : undefined;
      }
      const res = validateYesNo(raw);
      if (res.ok) return res.value;
      process.stderr.write(`${colors.red(res.error)}\n`);
    }
  }

  if (spec.kind === 'enum') {
    const values = spec.enumValues ?? [];
    for (;;) {
      const raw = (
        await rl.question(colors.cyan(`  ${spec.name} (${values.join(' / ')})${def}: `))
      ).trim();
      if (raw === '' && !spec.required) return undefined;
      if (values.includes(raw)) return raw;
      process.stderr.write(`${colors.red(`Please enter one of: ${values.join(', ')}`)}\n`);
    }
  }

  if (spec.kind === 'number') {
    for (;;) {
      const raw = (await rl.question(colors.cyan(`  ${spec.name} (number)${def}: `))).trim();
      if (raw === '' && !spec.required) return undefined;
      const n = Number(raw);
      if (raw !== '' && Number.isFinite(n)) return n;
      process.stderr.write(`${colors.red('Please enter a valid number.')}\n`);
    }
  }

  // string
  for (;;) {
    const raw = await rl.question(colors.cyan(`  ${spec.name}${opt}${def}: `));
    if (raw === '' && !spec.required) return undefined;
    if (raw.length > 0) return raw;
    process.stderr.write(`${colors.red('This field is required.')}\n`);
  }
}

/** Kleiner Helfer: erneut nach einem Pflicht-Boolean fragen. */
async function promptRetry(rl: Interface, spec: ParamSpec): Promise<unknown> {
  process.stderr.write(`${colors.red('This field is required.')}\n`);
  return promptParam(rl, spec);
}

/**
 * Fragt alle Parameter einer Operation ab und validiert sie gegen das
 * registrierte Schema. Bei Validierungsfehler wird die Operation verworfen
 * (Rückgabe `undefined`), damit der Nutzer sie neu wählen kann.
 */
async function collectOperation(rl: Interface, type: string): Promise<CollectedOp | undefined> {
  const op = getOperation(type);
  if (!op) return undefined;

  const specs = describeOperationParams(op.schema);
  const raw: Record<string, unknown> = {};

  output.write(colors.bold(`\nConfiguring "${type}":\n`));
  for (const spec of specs) {
    const value = await promptParam(rl, spec);
    if (value !== undefined) {
      raw[spec.name] = value;
    }
  }

  const parsed = op.schema.safeParse(raw);
  if (!parsed.success) {
    process.stderr.write(colors.red('\nInvalid parameters:\n'));
    for (const issue of parsed.error.issues) {
      const path = issue.path.length > 0 ? issue.path.join('.') : '<root>';
      process.stderr.write(colors.red(`  • ${path}: ${issue.message}\n`));
    }
    return undefined;
  }

  return { type, params: parsed.data as Record<string, unknown> };
}

/**
 * Sammelt interaktiv die Operationskette (mindestens eine Operation).
 */
export async function collectOperations(rl: Interface): Promise<CollectedOp[]> {
  const available = listOperations();
  const collected: CollectedOp[] = [];

  for (;;) {
    output.write(colors.bold('\nAvailable operations:\n'));
    available.forEach((op, i) => {
      output.write(`  ${colors.green(String(i + 1))}. ${op.type} — ${colors.gray(op.description)}\n`);
    });
    const doneHint = collected.length > 0 ? " or 'd' to finish" : '';
    const raw = (
      await rl.question(colors.cyan(`Select an operation (1-${available.length})${doneHint}: `))
    ).trim();

    if (collected.length > 0 && (raw === 'd' || raw === 'D')) {
      return collected;
    }

    const idx = Number(raw);
    const chosen =
      Number.isInteger(idx) && idx >= 1 && idx <= available.length ? available[idx - 1] : undefined;
    if (!chosen) {
      process.stderr.write(colors.red('Invalid selection.\n'));
      continue;
    }

    const op = await collectOperation(rl, chosen.type);
    if (op) {
      collected.push(op);
      output.write(colors.green(`✓ Added ${op.type} (${collected.length} total).\n`));
    }
  }
}
