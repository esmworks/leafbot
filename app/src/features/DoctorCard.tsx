import type { DoctorCheck, DoctorCheckId, DoctorReport } from '@leafbot/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CircleAlert, CircleCheck, TriangleAlert } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { useT } from '@/i18n';
import { api } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { cn } from '@/lib/utils';
import { Card, Row } from './SettingsPage';

/**
 * The server's own check of its data, for those who look after it: what a crash or a full disk
 * left wrong, and a repair for what can be mended without losing anything.
 */
export function DoctorCard() {
  const t = useT();
  const f = useFormat();
  const qc = useQueryClient();
  const { data, isFetching, refetch } = useQuery({
    queryKey: ['doctor'],
    queryFn: api.doctor,
    // Run when the person asks for it, not on every opening of the settings.
    enabled: false,
  });
  const repair = useMutation({
    mutationFn: (checks: DoctorCheckId[]) => api.repairDoctor(checks),
    onSuccess: (report: DoctorReport) => {
      qc.setQueryData(['doctor'], report);
      toast.success(
        report.movedTo ? t('doctor.repairedMoved', { path: report.movedTo }) : t('doctor.repaired'),
      );
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const mendable = (data?.checks ?? []).filter((c) => c.status !== 'ok' && c.repairable);
  const hint = (c: DoctorCheck) =>
    c.id === 'disk'
      ? t('doctor.diskHint', { free: f.fileSize(c.bytes ?? 0) })
      : c.status === 'ok'
        ? t(`doctor.${c.id}.ok`)
        : t(`doctor.${c.id}.found`, { count: c.count, size: f.fileSize(c.bytes ?? 0) });
  return (
    <Card title={t('doctor.title')}>
      <Row
        label={t('doctor.intro')}
        hint={data ? t('doctor.checkedAt', { time: f.shortTime(data.checkedAt) }) : undefined}
      >
        <Button
          size="sm"
          variant="secondary"
          className="rounded-full"
          disabled={isFetching}
          onClick={() => void refetch()}
        >
          {t(data ? 'doctor.again' : 'doctor.run')}
        </Button>
      </Row>
      {data?.checks.map((c) => (
        <Row key={c.id} label={t(`doctor.${c.id}.title`)} hint={hint(c)}>
          <span
            className={cn(
              'flex items-center gap-1.5 text-xs',
              c.status === 'ok'
                ? 'text-muted-foreground'
                : c.status === 'warn'
                  ? 'text-amber-600'
                  : 'text-destructive',
            )}
          >
            {c.status === 'ok' ? (
              <CircleCheck className="size-4" />
            ) : c.status === 'warn' ? (
              <TriangleAlert className="size-4" />
            ) : (
              <CircleAlert className="size-4" />
            )}
            {t(`doctor.status.${c.status}`)}
          </span>
        </Row>
      ))}
      {mendable.length > 0 && (
        <Row label={t('doctor.repairTitle')} hint={t('doctor.repairHint')}>
          <Button
            size="sm"
            className="rounded-full"
            disabled={repair.isPending}
            onClick={() => repair.mutate(mendable.map((c) => c.id))}
          >
            {t('doctor.repair')}
          </Button>
        </Row>
      )}
    </Card>
  );
}
