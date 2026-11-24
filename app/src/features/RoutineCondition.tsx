import { ROUTINE_CONDITION_MAX, type RoutineCondition, type RoutineConditionCheck } from '@leafbot/shared';
import { useQuery } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { useT } from '@/i18n';
import { api } from '@/lib/api';
import { useConnections } from '@/lib/queries';
import { Field } from './RoutinePage';

type Kind = RoutineConditionCheck['kind'];
const KINDS: Kind[] = ['files', 'email', 'whatsapp', 'table', 'tool', 'page'];

/** A first check of each kind, with the values the server would fill in. */
function blank(kind: Kind): RoutineConditionCheck {
  switch (kind) {
    case 'files':
      return { kind, folder: 'bot', pattern: '', min: 1, withinHours: null, absent: false };
    case 'email':
    case 'whatsapp':
      return { kind, filter: '', withinHours: 0, absent: false };
    case 'table':
      return { kind, tableId: '', filter: '', absent: false };
    case 'tool':
      return { kind, connectionId: '', tool: '', args: {}, filter: '', contains: '', absent: false };
    case 'page':
      return { kind, url: '', contains: '', absent: false };
  }
}

/** The whole number a field holds, or the fallback while it is empty. */
function whole(v: string, fallback: number): number {
  const n = Math.trunc(Number(v));
  return v.trim() === '' || !Number.isFinite(n) ? fallback : n;
}

const mono = 'rounded-xl font-mono text-xs';

/**
 * What must hold, checked with no AI, before a scheduled run starts: a switch that opens up to
 * five checks, how often to look again, and the note sent when it never held. A run started by
 * hand or by an event does not look at it.
 */
export function ConditionFields({
  botId,
  value,
  onChange,
}: {
  botId: string;
  value: RoutineCondition | null;
  onChange(next: RoutineCondition | null): void;
}) {
  const t = useT();
  const on = !!value;
  const checks = value?.checks ?? [];
  const set = (patch: Partial<RoutineCondition>) => value && onChange({ ...value, ...patch });
  const setCheck = (i: number, next: RoutineConditionCheck) =>
    set({ checks: checks.map((c, k) => (k === i ? next : c)) });
  return (
    <>
      <label className="flex items-start gap-3 rounded-2xl bg-secondary/60 px-3 py-2">
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium">{t('routine.condition')}</span>
          <span className="block text-xs text-muted-foreground">{t('routine.conditionHint')}</span>
        </span>
        <Switch
          checked={on}
          onCheckedChange={(v) =>
            onChange(
              v ? { checks: [blank('files')], recheckMinutes: 0, recheckUntil: '', otherwise: '' } : null,
            )
          }
        />
      </label>
      {value && (
        <div className="space-y-3 rounded-2xl bg-secondary/60 px-3 py-3">
          {checks.map((c, i) => (
            <CheckFields
              key={i}
              botId={botId}
              check={c}
              onChange={(next) => setCheck(i, next)}
              onRemove={
                checks.length > 1 ? () => set({ checks: checks.filter((_, k) => k !== i) }) : undefined
              }
            />
          ))}
          {checks.length < ROUTINE_CONDITION_MAX && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="rounded-full"
              onClick={() => set({ checks: [...checks, blank('files')] })}
            >
              <Plus /> {t('routine.conditionAdd')}
            </Button>
          )}
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="flex-1">{t('routine.conditionRecheck')}</span>
            <Switch
              checked={value.recheckMinutes > 0}
              onCheckedChange={(v) =>
                set(
                  v ? { recheckMinutes: 30, recheckUntil: '18:00' } : { recheckMinutes: 0, recheckUntil: '' },
                )
              }
            />
          </label>
          {value.recheckMinutes > 0 && (
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span>{t('routine.conditionEvery')}</span>
              <Input
                type="number"
                min={1}
                max={180}
                value={value.recheckMinutes}
                onChange={(e) =>
                  set({ recheckMinutes: Math.min(180, Math.max(1, whole(e.target.value, 1))) })
                }
                className="h-8 w-20 rounded-xl text-sm"
                aria-label={t('routine.conditionEvery')}
              />
              <span>{t('routine.conditionUntil')}</span>
              <Input
                type="time"
                value={value.recheckUntil}
                onChange={(e) => set({ recheckUntil: e.target.value })}
                className="h-8 w-28 rounded-xl text-sm"
                aria-label={t('routine.conditionUntil')}
              />
            </div>
          )}
          <Field label={t('routine.conditionOtherwise')}>
            <Textarea
              value={value.otherwise}
              onChange={(e) => set({ otherwise: e.target.value })}
              rows={2}
              maxLength={2000}
              placeholder={t('routine.conditionOtherwisePlaceholder')}
              className="rounded-xl"
            />
            <p className="mt-1 text-xs text-muted-foreground">{t('routine.conditionOtherwiseHint')}</p>
          </Field>
        </div>
      )}
    </>
  );
}

/** One check: its kind, the fields of that kind, and whether it holds when what it looks for is missing. */
function CheckFields({
  botId,
  check: c,
  onChange,
  onRemove,
}: {
  botId: string;
  check: RoutineConditionCheck;
  onChange(next: RoutineConditionCheck): void;
  onRemove?: () => void;
}) {
  const t = useT();
  return (
    <div className="space-y-2 rounded-xl bg-background/60 p-3">
      <div className="flex items-center gap-2">
        <Select value={c.kind} onValueChange={(v) => v !== c.kind && onChange(blank(v as Kind))}>
          <SelectTrigger className="w-full rounded-xl" aria-label={t('routine.conditionKind')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {KINDS.map((k) => (
              <SelectItem key={k} value={k}>
                {t(`routine.conditionKind.${k}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {onRemove && (
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="shrink-0 rounded-full"
            onClick={onRemove}
            aria-label={t('common.remove')}
          >
            <Trash2 className="size-4" />
          </Button>
        )}
      </div>
      {c.kind === 'files' && (
        <>
          <Select value={c.folder} onValueChange={(v) => onChange({ ...c, folder: v as 'bot' | 'group' })}>
            <SelectTrigger className="w-full rounded-xl" aria-label={t('routine.conditionFolder')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="bot">{t('routine.conditionFolder.bot')}</SelectItem>
              <SelectItem value="group">{t('routine.conditionFolder.group')}</SelectItem>
            </SelectContent>
          </Select>
          <Input
            value={c.pattern}
            onChange={(e) => onChange({ ...c, pattern: e.target.value })}
            placeholder={t('routine.conditionPatternPlaceholder')}
            maxLength={300}
            className={mono}
            spellCheck={false}
          />
          <Num
            label={t('routine.conditionMin')}
            value={c.min}
            min={1}
            max={1000}
            onChange={(n) => onChange({ ...c, min: n ?? 1 })}
          />
          <Num
            label={t('routine.conditionWithinHours')}
            value={c.withinHours}
            min={0}
            max={720}
            optional
            onChange={(n) => onChange({ ...c, withinHours: n })}
          />
        </>
      )}
      {(c.kind === 'email' || c.kind === 'whatsapp') && (
        <>
          <Textarea
            value={c.filter}
            onChange={(e) => onChange({ ...c, filter: e.target.value })}
            rows={2}
            maxLength={2000}
            placeholder={t(
              c.kind === 'email' ? 'routine.emailFilterPlaceholder' : 'routine.conditionWhatsappPlaceholder',
            )}
            className={mono}
            spellCheck={false}
          />
          <p className="text-xs text-muted-foreground">
            {t(c.kind === 'email' ? 'routine.emailFilterHint' : 'routine.conditionWhatsappHint')}
          </p>
          <Num
            label={t('routine.conditionWithinHoursMidnight')}
            value={c.withinHours}
            min={0}
            max={720}
            onChange={(n) => onChange({ ...c, withinHours: n ?? 0 })}
          />
        </>
      )}
      {c.kind === 'table' && <TableCheck botId={botId} check={c} onChange={onChange} />}
      {c.kind === 'tool' && <ToolCheck botId={botId} check={c} onChange={onChange} />}
      {c.kind === 'page' && (
        <>
          <Input
            value={c.url}
            onChange={(e) => onChange({ ...c, url: e.target.value })}
            placeholder={t('routine.watchUrlPlaceholder')}
            inputMode="url"
            maxLength={2000}
            className="rounded-xl"
          />
          <Input
            value={c.contains}
            onChange={(e) => onChange({ ...c, contains: e.target.value })}
            placeholder={t('routine.conditionContainsPlaceholder')}
            maxLength={500}
            className="rounded-xl"
          />
        </>
      )}
      <label className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="flex-1">{t('routine.conditionAbsent')}</span>
        <Switch checked={c.absent} onCheckedChange={(v) => onChange({ ...c, absent: v })} />
      </label>
    </div>
  );
}

/** A number beside its label; an optional one may be left empty. */
function Num({
  label,
  value,
  min,
  max,
  optional,
  onChange,
}: {
  label: string;
  value: number | null;
  min: number;
  max: number;
  optional?: boolean;
  onChange(n: number | null): void;
}) {
  return (
    <label className="flex items-center gap-2 text-xs text-muted-foreground">
      <span className="flex-1">{label}</span>
      <Input
        type="number"
        min={min}
        max={max}
        value={value ?? ''}
        onChange={(e) =>
          onChange(
            e.target.value.trim() === '' && optional
              ? null
              : Math.min(max, Math.max(min, whole(e.target.value, min))),
          )
        }
        className="h-8 w-24 rounded-xl text-sm"
      />
    </label>
  );
}

function TableCheck({
  botId,
  check: c,
  onChange,
}: {
  botId: string;
  check: Extract<RoutineConditionCheck, { kind: 'table' }>;
  onChange(next: RoutineConditionCheck): void;
}) {
  const t = useT();
  const { data: tables = [] } = useQuery({
    queryKey: ['tables', botId],
    queryFn: () => api.botTables(botId),
  });
  // A table the list does not show (removed since) keeps its place until another is picked.
  const known = !c.tableId || tables.some((x) => x.id === c.tableId);
  return (
    <>
      <Select value={c.tableId || undefined} onValueChange={(v) => onChange({ ...c, tableId: v })}>
        <SelectTrigger className="w-full rounded-xl" aria-label={t('routine.conditionTable')}>
          <SelectValue placeholder={t('routine.conditionTable')} />
        </SelectTrigger>
        <SelectContent>
          {!known && <SelectItem value={c.tableId}>{t('routine.conditionTableUnknown')}</SelectItem>}
          {tables.map((x) => (
            <SelectItem key={x.id} value={x.id}>
              {x.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Textarea
        value={c.filter}
        onChange={(e) => onChange({ ...c, filter: e.target.value })}
        rows={2}
        maxLength={2000}
        placeholder={t('routine.tableFilterPlaceholder')}
        className={mono}
        spellCheck={false}
      />
      <p className="text-xs text-muted-foreground">{t('routine.tableFilterHint')}</p>
    </>
  );
}

function ToolCheck({
  botId,
  check: c,
  onChange,
}: {
  botId: string;
  check: Extract<RoutineConditionCheck, { kind: 'tool' }>;
  onChange(next: RoutineConditionCheck): void;
}) {
  const t = useT();
  const { data: connections = [] } = useConnections();
  // Only tools that read, of connections this bot may use; the server checks the same on save.
  const options = connections
    .filter((x) => x.allBots || x.botIds.includes(botId))
    .flatMap((x) =>
      x.tools
        .filter((tool) => tool.kind === 'read' && tool.enabled)
        .map((tool) => ({
          value: `${x.id}\n${tool.name}`,
          label: `${x.name} · ${tool.title || tool.name}`,
        })),
    );
  const current = `${c.connectionId}\n${c.tool}`;
  const known = !c.tool || options.some((o) => o.value === current);
  const args = Object.keys(c.args).length ? JSON.stringify(c.args) : null;
  return (
    <>
      <Select
        value={c.tool ? current : undefined}
        onValueChange={(v) => {
          const [connectionId = '', tool = ''] = v.split('\n');
          // Another tool takes other arguments, so the old ones go.
          if (v !== current) onChange({ ...c, connectionId, tool, args: {} });
        }}
      >
        <SelectTrigger className="w-full rounded-xl" aria-label={t('routine.conditionTool')}>
          <SelectValue placeholder={t('routine.conditionTool')} />
        </SelectTrigger>
        <SelectContent>
          {!known && <SelectItem value={current}>{`${c.connectionId} · ${c.tool}`}</SelectItem>}
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {args && <code className="block break-all font-mono text-[11px] text-muted-foreground">{args}</code>}
      <Textarea
        value={c.filter}
        onChange={(e) => onChange({ ...c, filter: e.target.value })}
        rows={2}
        maxLength={2000}
        placeholder={t('routine.conditionToolFilterPlaceholder')}
        className={mono}
        spellCheck={false}
      />
      <Input
        value={c.contains}
        onChange={(e) => onChange({ ...c, contains: e.target.value })}
        placeholder={t('routine.conditionContainsPlaceholder')}
        maxLength={500}
        className="rounded-xl"
      />
      <p className="text-xs text-muted-foreground">{t('routine.conditionToolHint')}</p>
    </>
  );
}
