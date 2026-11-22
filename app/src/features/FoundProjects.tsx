import { useQuery } from '@tanstack/react-query';
import { FolderCode, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useT } from '@/i18n';
import { api } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { useUi } from '@/lib/store';
import { Card } from './SettingsPage';

/**
 * Folders the person's coding tools have worked in on this computer, each a click away from a bot
 * that works there too. Shown only when the server runs on that computer and finds some.
 */
export function FoundProjects() {
  const t = useT();
  const f = useFormat();
  const openSettings = useUi((s) => s.openSettings);
  const openBotPage = useUi((s) => s.openBotPage);
  const { data } = useQuery({ queryKey: ['setup-projects'], queryFn: api.setupProjects });
  const projects = data?.projects ?? [];
  if (!data?.available || !projects.length) return null;
  return (
    <Card title={t('projects.title')}>
      <p className="px-4 pt-3 text-xs text-muted-foreground">{t('projects.hint')}</p>
      <ul className="scroll-thin max-h-80 overflow-y-auto">
        {projects.map((p) => (
          <li key={p.path} className="flex items-center gap-3 px-4 py-2.5">
            <FolderCode className="size-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm">{p.name}</div>
              <div className="truncate text-xs text-muted-foreground" title={p.path}>
                {[p.sources.join(', '), p.lastUsed && f.dayLabel(p.lastUsed), p.path]
                  .filter(Boolean)
                  .join(' · ')}
              </div>
            </div>
            <Button
              size="sm"
              variant="outline"
              className="shrink-0 rounded-full"
              onClick={() => {
                openSettings(null);
                openBotPage({ mode: 'create', preset: { name: p.name, projectDir: p.path } });
              }}
            >
              <Plus className="size-4" /> {t('projects.makeBot')}
            </Button>
          </li>
        ))}
      </ul>
    </Card>
  );
}
