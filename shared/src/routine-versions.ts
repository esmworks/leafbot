import { z } from 'zod';
import type { RoutineCondition, RoutineStep } from './schedule';

/** What makes one version of a routine: what it is told, its steps, its model and its condition. */
export interface RoutineVersion {
  prompt: string;
  steps: RoutineStep[];
  model: string;
  condition: RoutineCondition | null;
}

export const ROUTINE_VERSION_PARTS = ['prompt', 'steps', 'model', 'condition'] as const;
export type RoutineVersionPart = (typeof ROUTINE_VERSION_PARTS)[number];

/** Below this many runs with a known ending, a version's numbers say little. */
export const VERSION_FEW_RUNS = 5;

/**
 * The same value written the same way: keys in order, and a field left empty read as one left out.
 * The routine form writes every step with its empty fields while the bot and the API leave them
 * out; saving a routine unchanged from the form must not make a new version of it.
 */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined && v !== null && v !== '') out[key] = canonical(v);
    }
    return out;
  }
  return value;
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonical(a ?? null)) === JSON.stringify(canonical(b ?? null));
}

/** A version as a history row or a routine has it; parts left out read as empty. */
export interface VersionLike {
  prompt: string;
  steps?: RoutineStep[] | null;
  model?: string | null;
  condition?: RoutineCondition | null;
  full?: boolean;
}

/**
 * Which parts differ between two versions. A version kept before steps, model and condition were
 * kept says only what it was told: the rest is compared only when both kept it.
 */
export function versionChanges(newer: VersionLike, older: VersionLike): RoutineVersionPart[] {
  const out: RoutineVersionPart[] = [];
  if (newer.prompt !== older.prompt) out.push('prompt');
  if (newer.full === false || older.full === false) return out;
  if (!same(newer.steps ?? [], older.steps ?? [])) out.push('steps');
  if ((newer.model ?? '') !== (older.model ?? '')) out.push('model');
  if (!same(newer.condition, older.condition)) out.push('condition');
  return out;
}

/** How the runs of one version went, counted as a routine's health counts them, over all its runs. */
export const RoutineVersionStats = z.object({
  /** Runs that started, leaving out slots passed over. */
  total: z.number().int(),
  ok: z.number().int(),
  quiet: z.number().int(),
  failed: z.number().int(),
  skipped: z.number().int(),
  /** What the runs with every turn priced cost. */
  costUsd: z.number(),
  unpricedRuns: z.number().int(),
  avgMs: z.number().nullable(),
});
export type RoutineVersionStats = z.infer<typeof RoutineVersionStats>;

/** Each version's numbers by its id, and those of runs from before versions were kept on them. */
export const RoutineVersionReport = z.object({
  versions: z.record(z.string(), RoutineVersionStats),
  untracked: RoutineVersionStats.nullable(),
});
export type RoutineVersionReport = z.infer<typeof RoutineVersionReport>;
