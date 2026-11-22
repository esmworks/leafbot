import type { ModelInfo, UsageRange } from '@leafbot/shared';
import { useQuery } from '@tanstack/react-query';
import { api, ApiError } from './api';

export const useBots = () => useQuery({ queryKey: ['bots'], queryFn: api.bots });
/** Who this device is signed in as. */
export const useSession = () => useQuery({ queryKey: ['session'], queryFn: api.session, staleTime: 60_000 });
/** Whether the one signed in looks after the server: its owner or an admin. */
export const useManagesServer = () => {
  const role = useSession().data?.user?.role;
  return role === 'owner' || role === 'admin';
};
export const usePeople = () => useQuery({ queryKey: ['people'], queryFn: api.people });
export const useGroups = () => useQuery({ queryKey: ['groups'], queryFn: api.groups });
export const useRooms = () => useQuery({ queryKey: ['rooms'], queryFn: api.rooms });
export const useMeetings = (roomId: string) =>
  useQuery({ queryKey: ['meetings', roomId], queryFn: () => api.meetings(roomId) });
export const useSummaries = () => useQuery({ queryKey: ['summaries'], queryFn: api.summaries });
export const useInfo = () => useQuery({ queryKey: ['info'], queryFn: api.info });
export const useSettings = () => useQuery({ queryKey: ['settings'], queryFn: api.settings });
/** Null on a server older than the in-app Claude sign-in. */
export const useClaudeAuth = () =>
  useQuery({
    queryKey: ['claude-auth'],
    queryFn: () =>
      api.claudeAuth().catch((e) => (e instanceof ApiError && e.status === 404 ? null : Promise.reject(e))),
  });
export const useClaudeModels = (enabled = true) =>
  useQuery({
    queryKey: ['claude-models'],
    queryFn: () =>
      api.claudeModels().catch((e) => (e instanceof ApiError && e.status === 404 ? [] : Promise.reject(e))),
    enabled,
    staleTime: 5 * 60_000,
  });
export const useProviders = () => useQuery({ queryKey: ['providers'], queryFn: api.providers });
export const useProviderModels = (id: string | null) =>
  useQuery({
    queryKey: ['provider-models', id],
    queryFn: () => api.providerModels(id!),
    enabled: !!id,
    staleTime: Infinity,
  });
/**
 * A provider's models with names and thinking levels. A server older than that list gives names
 * alone; their thinking levels are then unknown (null).
 */
export const useProviderModelInfo = (id: string | null) =>
  useQuery({
    queryKey: ['provider-models', id, 'info'],
    queryFn: () =>
      api.providerModelInfo(id!).catch(async (e): Promise<ModelInfo[]> => {
        if (!(e instanceof ApiError && e.status === 404)) throw e;
        return (await api.providerModels(id!)).map((m) => ({
          id: m,
          name: m,
          efforts: null,
          images: false,
          contextWindow: null,
          released: null,
        }));
      }),
    enabled: !!id,
    staleTime: 5 * 60_000,
  });
export const useApprovals = () => useQuery({ queryKey: ['approvals'], queryFn: api.approvals });
export const useRules = () => useQuery({ queryKey: ['rules'], queryFn: api.rules });
export const useVault = () => useQuery({ queryKey: ['vault'], queryFn: api.vault });
export const useConnections = () => useQuery({ queryKey: ['connections'], queryFn: api.connections });
/** Who a mail connection sends as; it changes rarely, so it is read again only now and then. */
export const useMailSender = (connectionId: string | undefined) =>
  useQuery({
    queryKey: ['connection-sender', connectionId],
    queryFn: () => api.connectionSender(connectionId!),
    enabled: !!connectionId,
    staleTime: 10 * 60_000,
  });
export const useMemory = () => useQuery({ queryKey: ['memory'], queryFn: api.memory });
// Under `memory`, so a change to any note brings the list up to date.
export const useStaleMemory = () => useQuery({ queryKey: ['memory', 'stale'], queryFn: api.staleMemory });
/** Under `memory` too; looked at again every few seconds while a pass runs, as it says nothing until it ends. */
export const useMemoryTidy = () =>
  useQuery({
    queryKey: ['memory', 'tidy'],
    queryFn: api.memoryTidy,
    refetchInterval: (q) => (q.state.data?.running ? 5000 : false),
  });
/** The turns of a conversation the person may take back: those that changed something. */
export const useTurnChanges = (threadId: string) =>
  useQuery({
    queryKey: ['turn-changes', threadId],
    queryFn: () => api.turnChangesPending(threadId),
    // Rarely changes, and only while a turn runs or after one is taken back.
    staleTime: 30_000,
  });
/** The person's open promises: a bot's, and their own to others. */
export const usePromises = (enabled = true) =>
  useQuery({ queryKey: ['promises'], queryFn: api.promises, enabled });
/** Routines offered because the person keeps asking a bot for the same thing by hand. */
export const useRoutineSuggestions = (enabled = true) =>
  useQuery({ queryKey: ['routine-suggestions'], queryFn: api.routineSuggestions, enabled });
export const useFollowUps = (enabled = true) =>
  useQuery({ queryKey: ['follow-ups'], queryFn: api.followUps, enabled });
export const useSkillSuggestions = (enabled = true) =>
  useQuery({ queryKey: ['skill-suggestions'], queryFn: api.skillSuggestions, enabled });
export const useRoutines = () => useQuery({ queryKey: ['routines'], queryFn: api.routines });
export const useSkills = () => useQuery({ queryKey: ['skills'], queryFn: api.skills });
export const useUsage = (days: UsageRange, botId?: string) =>
  useQuery({ queryKey: ['usage', days, botId], queryFn: () => api.usage(days, botId), staleTime: 30_000 });
/** How much room the bots' folders take; read from disk, so only while it is on screen. */
export const useStorage = () => useQuery({ queryKey: ['storage'], queryFn: api.storage, staleTime: 60_000 });
/**
 * The Claude plan's usage windows, as the last Claude turn heard them. A turn that hears new ones
 * pushes a refresh; the slow poll keeps a page left open from showing a reset as still to come.
 */
export const usePlanUsage = () =>
  useQuery({
    queryKey: ['plan-usage'],
    // A server older than the meter has no such route: nothing to show, nothing to retry.
    queryFn: () =>
      api
        .planUsage()
        .then((r) => r.plan)
        .catch((e) => (e instanceof ApiError && e.status === 404 ? null : Promise.reject(e))),
    staleTime: 60_000,
    refetchInterval: 10 * 60_000,
  });

export const useThreads = (botId: string | null) =>
  useQuery({ queryKey: ['threads', botId], queryFn: () => api.threads(botId!), enabled: !!botId });
export const useMainThread = (botId: string | null) =>
  useQuery({ queryKey: ['main-thread', botId], queryFn: () => api.mainThread(botId!), enabled: !!botId });
export const useMessages = (threadId: string | null) =>
  useQuery({ queryKey: ['messages', threadId], queryFn: () => api.messages(threadId!), enabled: !!threadId });
export const useJob = (jobId: string | null) =>
  useQuery({ queryKey: ['job', jobId], queryFn: () => api.job(jobId!), enabled: !!jobId });
export const useLibrary = (botId: string | null) =>
  useQuery({ queryKey: ['library', botId], queryFn: () => api.library(botId!), enabled: !!botId });
