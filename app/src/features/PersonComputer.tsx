import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { useT } from '@/i18n';
import { api } from '@/lib/api';

/**
 * The switch that lets a bot use this Mac, shown only to the server's owner and only where the
 * server runs on their Mac. With it on, it says which of macOS's two permissions are still missing
 * and opens macOS's prompts for them.
 */
export function PersonComputerSwitch({ on, onChange }: { on: boolean; onChange: (on: boolean) => void }) {
  const t = useT();
  const qc = useQueryClient();
  // Only the owner may ask; for anyone else the request is refused and nothing shows.
  const { data } = useQuery({
    queryKey: ['person-computer'],
    queryFn: api.personComputer,
    retry: false,
    // macOS's settings change outside the app: looked at again when the window comes back.
    refetchOnWindowFocus: true,
  });
  const ask = useMutation({
    mutationFn: api.requestPersonComputer,
    onSuccess: (state) => qc.setQueryData(['person-computer'], state),
  });
  if (!data?.available) return null;
  const missing = [
    ...(data.accessibility ? [] : [t('bot.personComputerAccessibility')]),
    ...(data.screen ? [] : [t('bot.personComputerScreen')]),
  ];
  return (
    <div className="rounded-2xl bg-secondary/60 px-4 py-3">
      <label className="flex items-center justify-between gap-4">
        <span>
          <span className="block text-sm font-medium">{t('bot.personComputer')}</span>
          <span className="block text-xs text-muted-foreground">{t('bot.personComputerHint')}</span>
        </span>
        <Switch checked={on} onCheckedChange={onChange} />
      </label>
      {on && missing.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground">
            {t('bot.personComputerMissing', { what: missing.join(', ') })}
          </span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={ask.isPending}
            onClick={() => ask.mutate()}
          >
            {t('bot.personComputerAllow')}
          </Button>
        </div>
      )}
    </div>
  );
}
