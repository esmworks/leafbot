import type { SkillSuggestion } from '@leafbot/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { BotAvatar } from '@/components/BotAvatar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { useT } from '@/i18n';
import { api } from '@/lib/api';
import { useBots, useSkillSuggestions } from '@/lib/queries';

/** One suggestion: the kind of task, the skill to read and edit, and the two answers. */
function SuggestionCard({ s }: { s: SkillSuggestion }) {
  const t = useT();
  const qc = useQueryClient();
  const { data: bots = [] } = useBots();
  const bot = bots.find((b) => b.id === s.botId);
  const [name, setName] = useState(s.name);
  const [description, setDescription] = useState(s.description);
  const [body, setBody] = useState(s.body);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['skill-suggestions'] });
    void qc.invalidateQueries({ queryKey: ['skills'] });
  };
  const fail = (e: unknown) => {
    toast.error((e as Error).message);
    refresh();
  };
  const create = useMutation({
    mutationFn: () =>
      api.acceptSkillSuggestion(s.id, {
        name: name.trim() || s.name,
        description: description.trim() || s.description,
        body: body.trim() || s.body,
      }),
    onSuccess: (skill) => {
      toast.success(t('skillSuggest.created', { name: skill.name, bot: bot?.name ?? t('common.bot') }));
      refresh();
    },
    onError: fail,
  });
  const dismiss = useMutation({
    mutationFn: () => api.dismissSkillSuggestion(s.id),
    onSuccess: refresh,
    onError: fail,
  });
  const botName = bot?.name ?? t('common.bot');
  return (
    <div className="space-y-2 px-3 py-2.5">
      <div className="flex items-start gap-2">
        {bot && <BotAvatar avatar={bot.avatar} color={bot.color} seed={bot.id} size={24} />}
        <div className="min-w-0 flex-1">
          <div className="font-medium">{s.description}</div>
          <div className="text-xs text-muted-foreground">
            {t('skillSuggest.line', { bot: botName, count: s.requests, days: s.days.length })}
          </div>
        </div>
      </div>
      {s.canCreate ? (
        <>
          <Input
            value={name}
            aria-label={t('skillSuggest.name')}
            onChange={(e) => setName(e.target.value)}
            className="h-8 rounded-full font-mono text-xs"
          />
          <Input
            value={description}
            aria-label={t('skillSuggest.description')}
            onChange={(e) => setDescription(e.target.value)}
            className="h-8 rounded-full text-sm"
          />
          <Textarea
            value={body}
            aria-label={t('skillSuggest.body')}
            onChange={(e) => setBody(e.target.value)}
            className="min-h-40 rounded-xl text-sm"
          />
        </>
      ) : (
        <p className="text-xs text-muted-foreground">{t('skillSuggest.askOwner', { bot: botName })}</p>
      )}
      <div className="flex justify-end gap-2">
        <Button
          variant="ghost"
          size="sm"
          className="rounded-full"
          disabled={dismiss.isPending || create.isPending}
          onClick={() => dismiss.mutate()}
        >
          {t('skillSuggest.dismiss')}
        </Button>
        {s.canCreate && (
          <Button
            size="sm"
            className="rounded-full"
            disabled={!body.trim() || create.isPending || dismiss.isPending}
            onClick={() => create.mutate()}
          >
            {t('skillSuggest.create')}
          </Button>
        )}
      </div>
    </div>
  );
}

/**
 * Many-step tasks the person keeps asking a bot for, offered as skills written from how the bot
 * did them. The skill can be changed before it is added. Nothing is shown when there are none.
 */
export function SkillSuggestionsSection({ enabled }: { enabled: boolean }) {
  const t = useT();
  const { data: suggestions = [] } = useSkillSuggestions(enabled);
  if (!suggestions.length) return null;
  return (
    <section>
      <h3 className="mb-1.5 px-1 text-xs font-medium text-muted-foreground">{t('skillSuggest.title')}</h3>
      <div className="divide-y rounded-2xl border bg-card/50">
        {suggestions.map((s) => (
          <SuggestionCard key={s.id} s={s} />
        ))}
      </div>
    </section>
  );
}
