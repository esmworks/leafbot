import type { Message } from '@leafbot/shared';

/**
 * A routine's instruction in a conversation, drawn as its run's line. One that carries what started
 * the run (a mail, a page) is outside text the person reads, and stays a message.
 */
export function isRoutineRunLine(m: Message): boolean {
  return m.role === 'user' && m.author.startsWith('routine:') && !m.props.payload;
}

/** The runs a folded line stands for, oldest first; null for any other row. */
export function foldedRuns(m: Message): Message[] | null {
  const runs = m.props.routineRuns;
  return Array.isArray(runs) ? (runs as Message[]) : null;
}

function day(iso: string) {
  const d = new Date(iso);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/** A finished run's line that another of the same routine may fold into. */
function foldable(m: Message): boolean {
  return isRoutineRunLine(m) && m.props.routineRunStatus === 'done';
}

/**
 * Lines of finished runs of one routine that follow each other on the same day, with nothing
 * between them, fold into one line that opens to them: a routine that runs every hour and finds
 * nothing to report leaves one line a day, not one an hour. The line where new messages start
 * begins a new fold, so it stays where it is.
 */
export function foldRoutineRuns(rows: readonly Message[], firstNew?: string | null): Message[] {
  const out: Message[] = [];
  let group: Message[] = [];
  const close = () => {
    const runs = new Set(group.map((m) => m.props.routineRunId));
    if (group.length > 1 && runs.size > 1) {
      const last = group.at(-1)!;
      out.push({ ...last, id: group[0]!.id, props: { ...last.props, routineRuns: group } });
    } else out.push(...group);
    group = [];
  };
  for (const m of rows) {
    const prev = group.at(-1);
    if (
      prev &&
      (!foldable(m) ||
        m.author !== prev.author ||
        day(m.createdAt) !== day(prev.createdAt) ||
        m.id === firstNew)
    )
      close();
    if (foldable(m)) group.push(m);
    else out.push(m);
  }
  close();
  return out;
}
