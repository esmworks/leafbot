import type { Bot, TaughtStep } from '@leafbot/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Circle, GraduationCap } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { useT } from '@/i18n';
import { api } from '@/lib/api';

/**
 * Teaching a task by showing it: the person names the result, does the task in the bot's browser
 * while it records, and gets the steps back as a skill to look over and save for the bot. What is
 * typed into a password field is never recorded.
 */
export function TeachTask({ bot }: { bot: Bot }) {
  const t = useT();
  const qc = useQueryClient();
  const [goal, setGoal] = useState('');
  const [asking, setAsking] = useState(false);
  const { data } = useQuery({
    queryKey: ['teach', bot.id],
    queryFn: () => api.teachStatus(bot.id),
    refetchInterval: (q) => (q.state.data?.steps != null ? 1500 : false),
  });
  const steps = data?.steps ?? null;
  const [draft, setDraft] = useState<Draft | null>(null);
  const start = useMutation({
    mutationFn: () => api.startTeaching(bot.id),
    onSuccess: () => {
      setAsking(false);
      void qc.invalidateQueries({ queryKey: ['teach', bot.id] });
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const stop = useMutation({
    mutationFn: () => api.stopTeaching(bot.id, goal),
    onSuccess: (d) => {
      setDraft(d);
      void qc.invalidateQueries({ queryKey: ['teach', bot.id] });
    },
    onError: (e) => {
      toast.error((e as Error).message);
      void qc.invalidateQueries({ queryKey: ['teach', bot.id] });
    },
  });
  return (
    <>
      {steps !== null ? (
        <div className="flex flex-wrap items-center gap-2 rounded-2xl bg-red-500/10 px-3 py-2 text-sm">
          <Circle className="size-3 animate-pulse fill-red-500 text-red-500" />
          <span className="min-w-0 flex-1">{t('teach.recording', { count: steps })}</span>
          <Button size="sm" className="rounded-full" disabled={stop.isPending} onClick={() => stop.mutate()}>
            {t('teach.finish')}
          </Button>
        </div>
      ) : asking ? (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            start.mutate();
          }}
        >
          <Input
            autoFocus
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            placeholder={t('teach.goalPlaceholder')}
            className="h-9 min-w-48 flex-1 rounded-full text-sm"
          />
          <Button type="submit" size="sm" className="rounded-full" disabled={start.isPending}>
            {t('teach.start')}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="rounded-full"
            onClick={() => setAsking(false)}
          >
            {t('common.cancel')}
          </Button>
          <p className="w-full px-1 text-xs text-muted-foreground">{t('teach.hint')}</p>
        </form>
      ) : (
        <Button size="sm" variant="secondary" className="w-fit rounded-full" onClick={() => setAsking(true)}>
          <GraduationCap /> {t('teach.open')}
        </Button>
      )}
      {draft && <SaveTaught bot={bot} draft={draft} onClose={() => setDraft(null)} />}
    </>
  );
}

/** What a lesson turned into, to look over before it is saved as a skill. */
interface Draft {
  name: string;
  description: string;
  body: string;
  taught: TaughtStep[];
}

function SaveTaught({ bot, draft, onClose }: { bot: Bot; draft: Draft; onClose(): void }) {
  const t = useT();
  const qc = useQueryClient();
  const [name, setName] = useState(draft.name);
  const [description, setDescription] = useState(draft.description);
  const [body, setBody] = useState(draft.body);
  const save = useMutation({
    // The steps go with the skill, so it can be replayed without the model.
    mutationFn: () => api.createSkill({ name, description, body, steps: draft.taught, botIds: [bot.id] }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['skills'] });
      toast.success(t('teach.saved', { bot: bot.name }));
      onClose();
    },
    onError: (e) => toast.error((e as Error).message),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex max-h-[85vh] flex-col overflow-hidden rounded-3xl sm:max-w-xl">
        <DialogTitle>{t('teach.reviewTitle')}</DialogTitle>
        <DialogDescription>{t('teach.reviewHint', { bot: bot.name })}</DialogDescription>
        <DialogBody className="space-y-4">
          <Input value={name} onChange={(e) => setName(e.target.value)} aria-label={t('teach.skillName')} />
          <Input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            aria-label={t('teach.skillWhen')}
          />
          <Textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={14}
            className="font-mono text-xs"
          />
        </DialogBody>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" className="rounded-full" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            className="rounded-full"
            disabled={save.isPending || !name.trim() || !description.trim()}
            onClick={() => save.mutate()}
          >
            {t('teach.save')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
