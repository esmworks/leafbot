import type { PluginPlan } from '@leafbot/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Puzzle, ShieldAlert } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { useT } from '@/i18n';
import { api } from '@/lib/api';

/**
 * Adds a plugin from its address: it is read first and its parts listed — servers to connect,
 * skills to save, and what is left out because it would run the plugin's code here — then the
 * person picks what goes in. Skills come in switched off; servers open to no bot until chosen.
 */
export function PluginDialog({ onClose }: { onClose(): void }) {
  const t = useT();
  const qc = useQueryClient();
  const [url, setUrl] = useState('');
  const [plan, setPlan] = useState<PluginPlan | null>(null);
  const [skip, setSkip] = useState<Set<string>>(new Set());
  const [tokens, setTokens] = useState<Record<string, string>>({});
  const preview = useMutation({
    mutationFn: () => api.previewPlugin(url.trim()),
    onSuccess: (p) => {
      setPlan(p);
      setSkip(new Set());
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const install = useMutation({
    mutationFn: () => api.installPlugin({ url: url.trim(), tokens, skip: [...skip] }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['skills'] });
      void qc.invalidateQueries({ queryKey: ['connections'] });
      toast.success(t('plugin.installed', { servers: r.servers, skills: r.skills }));
      onClose();
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const toggle = (name: string, on: boolean) =>
    setSkip((s) => {
      const next = new Set(s);
      if (on) next.delete(name);
      else next.add(name);
      return next;
    });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto rounded-3xl sm:max-w-lg">
        <DialogTitle className="flex items-center gap-2">
          <Puzzle className="size-5" /> {t('plugin.title')}
        </DialogTitle>
        <DialogDescription>{t('plugin.hint')}</DialogDescription>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (url.trim()) preview.mutate();
          }}
        >
          <Input
            autoFocus
            value={url}
            onChange={(e) => {
              setUrl(e.target.value);
              setPlan(null);
            }}
            placeholder={t('plugin.placeholder')}
            className="flex-1 rounded-full"
          />
          <Button className="rounded-full" disabled={!url.trim() || preview.isPending}>
            {t('plugin.read')}
          </Button>
        </form>
        {plan && (
          <div className="space-y-4 text-sm">
            <div>
              <div className="font-medium">
                {plan.name}
                {plan.version && <span className="text-muted-foreground"> · {plan.version}</span>}
              </div>
              {plan.description && <p className="text-muted-foreground">{plan.description}</p>}
            </div>
            {plan.servers.length > 0 && (
              <section className="space-y-2">
                <h4 className="text-xs font-medium text-muted-foreground">{t('plugin.servers')}</h4>
                {plan.servers.map((sv) => (
                  <div key={sv.name} className="space-y-1 rounded-xl border px-3 py-2">
                    <label className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        disabled={sv.exists}
                        checked={!sv.exists && !skip.has(sv.name)}
                        onChange={(e) => toggle(sv.name, e.target.checked)}
                      />
                      <span className="font-medium">{sv.name}</span>
                      <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{sv.url}</span>
                    </label>
                    {sv.exists && <p className="text-xs text-muted-foreground">{t('plugin.serverExists')}</p>}
                    {sv.needsToken && !sv.exists && !skip.has(sv.name) && (
                      <Input
                        type="password"
                        value={tokens[sv.name] ?? ''}
                        onChange={(e) => setTokens((x) => ({ ...x, [sv.name]: e.target.value }))}
                        placeholder={t('plugin.token')}
                        autoComplete="new-password"
                        className="h-8 text-sm"
                      />
                    )}
                  </div>
                ))}
              </section>
            )}
            {plan.skills.length > 0 && (
              <section className="space-y-2">
                <h4 className="text-xs font-medium text-muted-foreground">{t('plugin.skills')}</h4>
                {plan.skills.map((k) => (
                  <label key={k.name} className="flex items-start gap-2 rounded-xl border px-3 py-2">
                    <input
                      type="checkbox"
                      className="mt-1"
                      disabled={k.exists}
                      checked={!k.exists && !skip.has(k.name)}
                      onChange={(e) => toggle(k.name, e.target.checked)}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block font-medium">{k.name}</span>
                      <span className="block text-xs text-muted-foreground">
                        {k.exists ? t('plugin.skillExists') : k.description}
                      </span>
                      {k.warnings.length > 0 && (
                        <span className="mt-1 flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400">
                          <ShieldAlert className="size-3.5" />
                          {k.warnings.map((w) => t(`skills.warn.${w}`)).join(' ')}
                        </span>
                      )}
                    </span>
                  </label>
                ))}
              </section>
            )}
            {plan.leftOut.length > 0 && (
              <section className="space-y-1">
                <h4 className="text-xs font-medium text-muted-foreground">{t('plugin.leftOut')}</h4>
                <ul className="list-disc ps-5 text-xs text-muted-foreground">
                  {plan.leftOut.map((l) => (
                    <li key={l.part}>
                      {l.part} — {t(`plugin.why.${l.why}`)}
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {!plan.servers.length && !plan.skills.length && (
              <p className="text-muted-foreground">{t('plugin.nothing')}</p>
            )}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" className="rounded-full" onClick={onClose}>
                {t('common.cancel')}
              </Button>
              <Button
                className="rounded-full"
                disabled={install.isPending || (!plan.servers.length && !plan.skills.length)}
                onClick={() => install.mutate()}
              >
                {t('plugin.install')}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
