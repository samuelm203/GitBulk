/**
 * Introspektion der Zod-Parameter-Schemas einer Operation.
 *
 * Der interaktive Generator (`gitbulk init`) nutzt das, um pro Operation
 * automatisch die richtigen Parameter abzufragen — ohne dass jede Operation
 * ihre Prompts selbst definieren muss. Neue Operationen sind so „out of the
 * box" zusammenklickbar.
 *
 * Unterstützte Feldtypen: string, number, boolean, enum (jeweils ggf. in
 * `.optional()` / `.default(...)` verpackt). Andere Typen werden übersprungen.
 */

import { z } from 'zod';

/** Beschreibung eines einzelnen Operation-Parameters für die Prompt-Schicht. */
export interface ParamSpec {
  /** Feldname, wie er in der Config / im params-Objekt steht. */
  name: string;
  /** Grundtyp des Feldes. */
  kind: 'string' | 'number' | 'boolean' | 'enum';
  /** Muss der Wert angegeben werden (kein optional / kein default)? */
  required: boolean;
  /** Default-Wert, falls das Feld einen hat. */
  defaultValue?: unknown;
  /** Mögliche Werte, falls es ein enum ist. */
  enumValues?: readonly string[];
}

/**
 * Schält `ZodDefault` / `ZodOptional` / `ZodNullable` ab und liefert den
 * inneren Typ samt Optionalität und Default.
 */
function unwrap(schema: z.ZodTypeAny): {
  inner: z.ZodTypeAny;
  required: boolean;
  defaultValue: unknown;
} {
  let current: z.ZodTypeAny = schema;
  let required = true;
  let defaultValue: unknown;

  for (;;) {
    if (current instanceof z.ZodDefault) {
      defaultValue = current._def.defaultValue();
      required = false;
      current = current._def.innerType;
    } else if (current instanceof z.ZodOptional) {
      required = false;
      current = current._def.innerType;
    } else if (current instanceof z.ZodNullable) {
      current = current._def.innerType;
    } else {
      break;
    }
  }

  return { inner: current, required, defaultValue };
}

/**
 * Liefert die Parameter-Spezifikationen eines Operation-Schemas.
 * Gibt eine leere Liste zurück, wenn das Schema kein Objekt ist.
 */
export function describeOperationParams(schema: z.ZodTypeAny): ParamSpec[] {
  let obj: z.ZodTypeAny = schema;
  if (obj instanceof z.ZodEffects) {
    obj = obj._def.schema;
  }
  if (!(obj instanceof z.ZodObject)) {
    return [];
  }

  const shape = obj.shape as Record<string, z.ZodTypeAny>;
  const specs: ParamSpec[] = [];

  for (const [name, field] of Object.entries(shape)) {
    const { inner, required, defaultValue } = unwrap(field);

    let kind: ParamSpec['kind'];
    let enumValues: readonly string[] | undefined;

    if (inner instanceof z.ZodString) {
      kind = 'string';
    } else if (inner instanceof z.ZodNumber) {
      kind = 'number';
    } else if (inner instanceof z.ZodBoolean) {
      kind = 'boolean';
    } else if (inner instanceof z.ZodEnum) {
      kind = 'enum';
      enumValues = inner._def.values as readonly string[];
    } else {
      // Nicht unterstützter Feldtyp → überspringen (der Generator fragt ihn nicht ab).
      continue;
    }

    const spec: ParamSpec = { name, kind, required };
    if (defaultValue !== undefined) {
      spec.defaultValue = defaultValue;
    }
    if (enumValues !== undefined) {
      spec.enumValues = enumValues;
    }
    specs.push(spec);
  }

  return specs;
}
