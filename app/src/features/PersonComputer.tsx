import { useQuery } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { useT } from '@/i18n';
import { api } from '@/lib/api';
import { useUi } from '@/lib/store';

/** Whether a computer can be used by the bots, and which of macOS's permissions it has. */
export function usePersonComputer() {
  return useQuery({
    queryKey: ['person-computer'],
    queryFn: api.personComputer,
    retry: false,
    // macOS's settings change outside the app: looked at again when the window comes back.
    refetchOnWindowFocus: true,
  });
}

/** Whether the person has, or could connect, a computer for the bots: else nothing about it shows. */
export function useComputerOffered(): boolean {
  const { data } = usePersonComputer();
  return !!(data?.available || data?.remote);
}

/**
 * The switch that lets a bot use the computer (Mac or Windows) of the person it works for. Where the server runs on the
 * owner's computer, only the owner sees it. Where it runs elsewhere, everyone does: each person's computer is
 * the one their desktop app offers, and the switch says whether it is connected. With it on, it
 * says which of macOS's two permissions are still missing and leads to the settings section where
 * they are given, the one place for both.
 */
export function PersonComputerSwitch({ on, onChange }: { on: boolean; onChange: (on: boolean) => void }) {
  const t = useT();
  // Anyone signed in may ask; without a computer of theirs it says so, or nothing shows.
  const { data } = usePersonComputer();
  if (!data?.available && !data?.remote) return null;
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
      {on && data.remote && (
        <p className="mt-2 text-xs text-muted-foreground">
          {data.available && data.device
            ? t('bot.personComputerDevice', { device: data.device })
            : t('bot.personComputerRemote')}
        </p>
      )}
      {on && data.available && missing.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground">
            {t('bot.personComputerMissing', { what: missing.join(', ') })}
          </span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => useUi.getState().openSettings('computer')}
          >
            {t('bot.personComputerSettings')}
          </Button>
        </div>
      )}
    </div>
  );
}
