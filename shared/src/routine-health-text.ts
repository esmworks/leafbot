import type { RoutineHealth, RoutineHealthFinding } from './routine-health';

/** The catalog keys a routine's health is said with, in the web and the phone app alike. */
export type HealthTextKey =
  | 'health.seconds'
  | 'health.minutes'
  | 'health.hours'
  | 'health.days'
  | 'health.finding.failing'
  | 'health.finding.failingStreak'
  | 'health.finding.pausedByFailures'
  | 'health.finding.signInWait'
  | 'health.finding.stepFails'
  | 'health.finding.waitTimeouts'
  | 'health.finding.mostlyQuiet'
  | 'health.finding.mostlyQuietCost'
  | 'health.finding.idleOn'
  | 'health.finding.idleOff'
  | 'health.ask.failing'
  | 'health.ask.pausedByFailures'
  | 'health.ask.stepFails'
  | 'health.ask.mostlyQuiet'
  | 'health.ask.idle';

/** A translator that knows at least the health keys: each app passes its own. */
export type HealthT = (key: HealthTextKey, params?: Record<string, string | number>) => string;

/** A routine that wants the person to look at it: something wrong, something to gain, or not used. */
export function needsAttention(h: Pick<RoutineHealth, 'status'> | undefined): boolean {
  return h?.status === 'problem' || h?.status === 'improvable' || h?.status === 'unused';
}

/** How long, in the largest units that read well: seconds, minutes, hours, or days for runs that waited. */
export function duration(ms: number, t: HealthT): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return t('health.seconds', { seconds: s });
  if (s < 3600) return t('health.minutes', { minutes: Math.floor(s / 60), seconds: s % 60 });
  if (s < 86_400)
    return t('health.hours', { hours: Math.floor(s / 3600), minutes: Math.floor((s % 3600) / 60) });
  return t('health.days', { days: Math.round(s / 86_400) });
}

/** What a finding says, in the reader's language, from its numbers. */
export function findingText(f: RoutineHealthFinding, t: HealthT, usd: (n: number) => string): string {
  switch (f.id) {
    case 'failing':
      return f.of
        ? t('health.finding.failing', { count: f.count, of: f.of })
        : t('health.finding.failingStreak', { count: f.count });
    case 'pausedByFailures':
      return t('health.finding.pausedByFailures');
    case 'signInWait':
      return t('health.finding.signInWait');
    case 'stepFails':
      return t('health.finding.stepFails', { step: f.step ?? 0, count: f.count });
    case 'waitTimeouts':
      return t('health.finding.waitTimeouts', { step: f.step ?? 0, count: f.count });
    case 'mostlyQuiet': {
      const text = t('health.finding.mostlyQuiet', { count: f.count, of: f.of ?? f.count });
      return f.costUsd ? `${text} ${t('health.finding.mostlyQuietCost', { cost: usd(f.costUsd) })}` : text;
    }
    case 'idle':
      return f.enabled ? t('health.finding.idleOn') : t('health.finding.idleOff');
  }
}

/** The message written for the person to send the bot about a finding; null when the bot can't help. */
export function askText(routine: { name: string }, f: RoutineHealthFinding, t: HealthT): string | null {
  const name = routine.name;
  switch (f.id) {
    case 'failing':
      return t('health.ask.failing', { name });
    case 'pausedByFailures':
      return t('health.ask.pausedByFailures', { name });
    case 'stepFails':
      return t('health.ask.stepFails', { name, step: f.step ?? 0 });
    case 'mostlyQuiet':
      return t('health.ask.mostlyQuiet', { name });
    case 'idle':
      return f.enabled ? t('health.ask.idle', { name }) : null;
    default:
      return null;
  }
}
