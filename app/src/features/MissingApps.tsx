import { missingApps } from '@leafbot/shared';
import { useQuery } from '@tanstack/react-query';
import { PlugZap } from 'lucide-react';
import { useDeferredValue, useMemo } from 'react';
import { Button } from '@/components/ui/button';
import { useT } from '@/i18n';
import { api } from '@/lib/api';
import { useConnections } from '@/lib/queries';
import { useUi } from '@/lib/store';
import { AppLogo } from './Connections';

/**
 * Under an instruction: the apps it names that the bot cannot use yet, each with a way to connect
 * it, so a routine or a bot does not set out on work it has no access to.
 */
export function MissingApps({ text, botId }: { text: string; botId: string | null }) {
  const t = useT();
  const openApps = useUi((s) => s.openApps);
  const { data: connections } = useConnections();
  const { data: apis } = useQuery({ queryKey: ['api-sources'], queryFn: api.apiSources });
  const deferred = useDeferredValue(text);
  const missing = useMemo(
    () => (connections ? missingApps(deferred, botId, connections, apis ?? []) : []),
    [deferred, botId, connections, apis],
  );
  if (!missing.length) return null;
  return (
    <div className="space-y-2 rounded-2xl border border-amber-500/40 bg-amber-500/5 px-3 py-2.5 text-sm">
      <div className="flex items-start gap-2">
        <PlugZap className="mt-0.5 size-4 shrink-0 text-amber-500" />
        <span>
          {t('apps.missing', {
            apps: missing.map((e) => e.name).join(', '),
            count: missing.length,
          })}
        </span>
      </div>
      <div className="flex flex-wrap gap-1.5 ps-6">
        {missing.map((e) => (
          <Button
            key={e.id}
            type="button"
            size="sm"
            variant="secondary"
            className="h-7 rounded-full px-2.5 text-xs"
            onClick={() => openApps({ botId, catalogId: e.id })}
          >
            <AppLogo id={e.id} name={e.name} size={16} />
            {t('apps.missingConnect', { app: e.name })}
          </Button>
        ))}
      </div>
    </div>
  );
}
