import { filterVars, parseFields, ROUTINE_VAR_MAX, ROUTINE_VARS_MAX } from '@leafbot/shared';
import { Braces, Plus, X } from 'lucide-react';
import { Fragment, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useT, type MessageKey } from '@/i18n';
import type { StepForm } from './RoutineSteps';

/** A routine's input as its settings edit it: a name and the value a run takes unless given another. */
export type InputRow = { name: string; value: string };

/** What each step writes, where `{{name}}` may stand. */
const stepTexts = (s: StepForm): string[] =>
  s.kind === 'agent'
    ? [s.prompt]
    : s.kind === 'approval'
      ? [s.question]
      : s.kind === 'notify'
        ? [s.text]
        : s.kind === 'wait'
          ? [s.filter]
          : s.kind === 'fetch'
            ? [s.url]
            : [];

/**
 * The names the instruction and the steps write as `{{name}}` that nothing gives yet: neither an
 * input nor a step before that takes values from JSON. Offered for adding as inputs.
 */
export function namesWanted(
  prompt: string,
  steps: readonly StepForm[],
  inputs: readonly InputRow[],
): string[] {
  const have = new Set(inputs.map((i) => i.name.trim()));
  const wanted: string[] = [];
  const add = (text: string) => {
    for (const n of filterVars(text)) if (!have.has(n) && !wanted.includes(n)) wanted.push(n);
  };
  add(prompt);
  for (const s of steps) {
    for (const text of stepTexts(s)) add(text);
    if (s.kind === 'extract') for (const f of parseFields(s.fields) ?? []) have.add(f.name);
  }
  return wanted;
}

/**
 * The text with each `{{name}}` marked, as the flow's boxes show it, so the parts a run fills in
 * stand out from what is written as it is.
 */
export function markVars(text: string): ReactNode {
  const parts = text.split(/(\{\{\s*[A-Za-z][A-Za-z0-9_]{0,39}\s*\}\})/g);
  if (parts.length === 1) return text;
  return parts.map((part, i) =>
    i % 2 ? (
      <span
        key={i}
        className="rounded-md bg-[var(--brand)]/12 px-1 font-semibold text-[var(--brand)] [box-decoration-break:clone]"
      >
        {part.replace(/[{}\s]/g, '')}
      </span>
    ) : (
      <Fragment key={i}>{part}</Fragment>
    ),
  );
}

/** A routine's inputs: rows of a name and its usual value, and the names its texts want but lack. */
export function RoutineInputs({
  rows,
  onChange,
  wanted,
  errors,
}: {
  rows: InputRow[];
  onChange(next: InputRow[]): void;
  wanted: string[];
  /** What is wrong with each row's name, by row. */
  errors?: (string | undefined)[];
}) {
  const t = useT();
  const full = rows.length >= ROUTINE_VARS_MAX;
  const set = (i: number, next: Partial<InputRow>) =>
    onChange(rows.map((r, j) => (j === i ? { ...r, ...next } : r)));
  return (
    <div className="space-y-2 rounded-2xl bg-secondary/60 px-3 py-2.5">
      <div className="flex items-start gap-2">
        <Braces className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium">{t('routine.inputs')}</span>
          <span className="block text-xs text-muted-foreground">{t('routine.inputsHint')}</span>
        </span>
      </div>
      {rows.map((r, i) => (
        <div key={i} className="space-y-1">
          <div className="flex items-center gap-2">
            <Input
              value={r.name}
              onChange={(e) => set(i, { name: e.target.value })}
              aria-label={t('routine.inputName')}
              placeholder={t('routine.inputName')}
              aria-invalid={!!errors?.[i]}
              className="h-8 w-36 shrink-0 rounded-lg font-medium"
            />
            <Input
              value={r.value}
              maxLength={ROUTINE_VAR_MAX}
              onChange={(e) => set(i, { value: e.target.value })}
              aria-label={t('routine.inputValue', { name: r.name || '…' })}
              placeholder={t('routine.inputValuePlaceholder')}
              className="h-8 min-w-0 flex-1 rounded-lg"
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-8 shrink-0 rounded-full"
              onClick={() => onChange(rows.filter((_, j) => j !== i))}
              aria-label={t('routine.inputRemove', { name: r.name || '…' })}
            >
              <X className="size-4" />
            </Button>
          </div>
          {errors?.[i] && <p className="text-xs text-destructive">{t(errors[i] as MessageKey)}</p>}
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-1.5">
        {/* A name the texts already use is one click away. */}
        {!full &&
          wanted.map((name) => (
            <Button
              key={name}
              type="button"
              size="sm"
              variant="outline"
              className="h-7 rounded-full bg-background px-2.5 text-xs"
              onClick={() => onChange([...rows, { name, value: '' }])}
              title={t('routine.inputAddUsed', { name })}
            >
              <Plus className="size-3" /> {name}
            </Button>
          ))}
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-7 rounded-full px-2.5 text-xs"
          disabled={full}
          onClick={() => onChange([...rows, { name: '', value: '' }])}
        >
          <Plus className="size-3" /> {t('routine.inputAdd')}
        </Button>
      </div>
    </div>
  );
}
