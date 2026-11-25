import type { PersonJobCard as Job } from '@leafbot/shared';
import { useMutation } from '@tanstack/react-query';
import { Loader2, Square, Terminal } from 'lucide-react';
import { toast } from 'sonner';
import { useT } from '@/i18n';
import { api } from '@/lib/api';

/**
 * A command a bot runs on the person's own computer: what runs where, how it stands, its last lines,
 * and a way to stop it while it runs. The newest lines come from the computer every few seconds.
 */
export function PersonJobCard({ job }: { job: Job }) {
  const t = useT();
  const running = job.status === 'running';
  const stop = useMutation({
    mutationFn: () => api.stopPersonJob(job.id),
    onError: (e) => toast.error((e as Error).message),
  });
  const state =
    job.status === 'done'
      ? t('personJob.done', { code: String(job.exitCode ?? '?') })
      : t(`personJob.${job.status}`);
  return (
    <section
      aria-label={t('personJob.title')}
      className="wallpaper-frost max-w-[80%] min-w-64 self-start rounded-2xl border bg-card/60 px-4 py-3 text-sm"
    >
      <div className="flex items-start gap-2">
        <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center text-muted-foreground">
          {running ? (
            <Loader2 className="size-3.5 animate-spin" aria-hidden />
          ) : (
            <Terminal className="size-3.5" aria-hidden />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-4 text-xs text-muted-foreground">
            <span className="font-medium">{t('personJob.title')}</span>
            <span>{state}</span>
          </div>
          <code className="mt-1 block font-mono text-xs break-all whitespace-pre-wrap">{job.command}</code>
          <div className="mt-1 text-xs break-all text-muted-foreground">
            {t('personJob.where', { device: job.device, cwd: job.cwd })}
          </div>
          {(job.tail || running) && (
            <pre className="mt-2 max-h-48 overflow-y-auto rounded-lg border bg-background/60 px-3 py-2 font-mono text-xs break-words whitespace-pre-wrap">
              {job.tail || t('personJob.noOutput')}
            </pre>
          )}
          {running && (
            <button
              type="button"
              className="mt-2 flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs hover:bg-muted disabled:opacity-50"
              disabled={stop.isPending}
              onClick={() => stop.mutate()}
            >
              <Square className="size-3" aria-hidden />
              {t('personJob.stop')}
            </button>
          )}
        </div>
      </div>
    </section>
  );
}
