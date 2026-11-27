import { cardPlace, FULL_PAGE, type Bot, type Message, type Thread } from '@leafbot/shared';
import { conversationMarkdown } from '@leafbot/app/src/lib/exportChat';
import { useQueryClient } from '@tanstack/react-query';
import * as Clipboard from 'expo-clipboard';
import { useMemo } from 'react';
import { Share } from 'react-native';
import { askText, confirm, toast, toastError } from '@/components/overlay';
import { locale, t } from '@/i18n';
import { formatters } from '@/lib/format';
import { nav } from '@/lib/nav';
import { useApprovals, useBots, useMainThread, useSettings, useThreads } from '@/lib/queries';
import { useApi, useServer } from '@/lib/server';
import { threadLink } from './text';

const fmt = formatters(locale, t);

/** A conversation's name in lists: a bot conversation without a title is named after the other bot. */
export function useThreadName(mainId: string | undefined) {
  const { data: bots = [] } = useBots();
  return (th: Thread) => {
    if (th.id === mainId) return t('chat.mainThread');
    if (th.title) return th.title;
    const peer = th.peerBotId ? bots.find((b) => b.id === th.peerBotId) : undefined;
    return peer ? t('chat.withBot', { bot: peer.name }) : t('chat.newThread');
  };
}

/**
 * The bot's cards still waiting for an answer, counted per conversation. The list counts them all,
 * wherever they are, so every conversation they are in needs to be findable from here.
 */
export function useWaitingCards(botId: string | undefined): Map<string, number> {
  const { data: approvals } = useApprovals();
  return useMemo(() => {
    const byThread = new Map<string, number>();
    // A card asked between bots counts where it is shown: with the bot the work began with.
    for (const a of approvals ?? []) {
      const place = cardPlace(a);
      if (place.botId === botId && a.status === 'pending')
        byThread.set(place.threadId, (byThread.get(place.threadId) ?? 0) + 1);
    }
    return byThread;
  }, [approvals, botId]);
}

export type ThreadActions = ReturnType<typeof useThreadActions>;

/** What the conversation menu and the `/` commands do to a bot's conversations. */
export function useThreadActions(bot: Bot) {
  const api = useApi();
  const qc = useQueryClient();
  const { origin } = useServer();
  const { data: bots = [] } = useBots();
  const { data: settings } = useSettings();
  const { data: threads = [] } = useThreads(bot.id);
  const main = useMainThread(bot.id);
  const name = useThreadName(main.data?.id);

  const refresh = (threadId?: string) => {
    void qc.invalidateQueries({ queryKey: ['main-thread', origin, bot.id] });
    if (threadId) void qc.invalidateQueries({ queryKey: ['thread', origin, threadId] });
    return qc.invalidateQueries({ queryKey: ['threads', origin, bot.id] });
  };
  /** Opens a conversation of this bot; none opens its main one. */
  const open = (threadId?: string) => nav.replaceChat(bot.id, threadId ? { threadId } : {});

  const create = () =>
    api
      .newThread(bot.id)
      .then(async (created) => {
        // The list has to know the new conversation before the screen asks for it, or the screen
        // takes it for one that is gone and goes back to the main one.
        await refresh();
        open(created.id);
      })
      .catch(toastError);

  const patch = (th: Thread, change: Parameters<typeof api.updateThread>[1], leave = false) =>
    api
      .updateThread(th.id, change)
      .then(() => {
        if (leave) open();
        return refresh(th.id);
      })
      .catch(toastError);

  return {
    name,
    open,
    create,
    patch,
    archive: (th: Thread, on: boolean) => patch(th, { archived: on }, on),
    rename: async (th: Thread) => {
      const next = await askText({
        title: t('chat.renamePrompt'),
        initial: th.title || name(th),
        maxLength: 120,
        confirmLabel: t('common.save'),
      });
      if (next === null || !next.trim()) return;
      await patch(th, { title: next.trim().slice(0, 120) });
    },
    reset: async (th: Thread) => {
      const ok = await confirm({
        title: t('chat.resetThread'),
        message: t('chat.resetConfirm'),
        confirmLabel: t('chat.resetThread'),
      });
      if (!ok) return;
      await api
        .resetThread(th.id)
        .then(() => {
          void qc.invalidateQueries({ queryKey: ['messages', origin, th.id] });
          return refresh(th.id);
        })
        .catch(toastError);
    },
    remove: async (th: Thread) => {
      const ok = await confirm({
        title: t('chat.deleteThread'),
        message: t('chat.deleteConfirm', { name: name(th) }),
        confirmLabel: t('common.delete'),
        destructive: true,
      });
      if (!ok) return;
      await api
        .deleteThread(th.id)
        .then(() => {
          open();
          return refresh();
        })
        .catch(toastError);
    },
    copyLink: async (th: Thread) => {
      try {
        await Clipboard.setStringAsync(threadLink(origin ?? '', th.id));
        toast(t('chat.linkCopied'));
      } catch {
        toast(t('message.copyFailed'), { tone: 'error' });
      }
    },
    /** Hands the whole conversation, also what is not loaded on screen, to the share sheet as Markdown. */
    exportConversation: async (threadId: string) => {
      try {
        const all: Message[] = [];
        for (let before: string | undefined; ;) {
          const page = await api.messages(threadId, before, FULL_PAGE);
          all.unshift(...page);
          if (page.length < FULL_PAGE || !page[0]) break;
          before = page[0].id;
        }
        const thread = threads.find((th) => th.id === threadId) ?? main.data;
        const title = `${bot.name} · ${thread ? name(thread) : t('chat.mainThread')}`;
        const author = (m: Message) => {
          if (m.author === 'user') return settings?.userName || t('export.you');
          const id = m.author.startsWith('bot:') ? m.author.slice(4) : null;
          if (id) return bots.find((b) => b.id === id)?.name ?? t('common.bot');
          return m.author.startsWith('routine:') ? t('export.routine') : m.author;
        };
        const md = conversationMarkdown(title, all, { author, time: (iso) => fmt.dayLabel(iso) });
        await Share.share({ title, message: md });
      } catch (e) {
        toastError(e);
      }
    },
  };
}
