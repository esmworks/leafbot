import type { UsageRange } from '@leafbot/shared';
import { useQuery } from '@tanstack/react-query';
import { ApiError } from './api';
import { useApi, useServer } from './server';

/**
 * Every server read the screens share, keyed `[name, origin, ...]` so live pushes (realtime.tsx)
 * refresh the same entries and two servers never mix.
 */
function useOrigin(): string {
  return useServer().origin ?? '';
}

export const useBots = () => {
  const api = useApi();
  return useQuery({ queryKey: ['bots', useOrigin()], queryFn: api.bots });
};
export const useGroups = () => {
  const api = useApi();
  return useQuery({ queryKey: ['groups', useOrigin()], queryFn: api.groups });
};
export const useRooms = () => {
  const api = useApi();
  return useQuery({ queryKey: ['rooms', useOrigin()], queryFn: api.rooms });
};
export const useSummaries = () => {
  const api = useApi();
  return useQuery({ queryKey: ['summaries', useOrigin()], queryFn: api.summaries });
};
export const useInfo = () => {
  const api = useApi();
  return useQuery({ queryKey: ['info', useOrigin()], queryFn: api.info });
};
export const useSettings = () => {
  const api = useApi();
  return useQuery({ queryKey: ['settings', useOrigin()], queryFn: api.settings });
};
export const useSession = () => {
  const api = useApi();
  return useQuery({ queryKey: ['session', useOrigin()], queryFn: api.session });
};
/** Whether the one signed in looks after the server: its owner or an admin. */
export const useManagesServer = () => {
  const role = useSession().data?.user?.role;
  return role === 'owner' || role === 'admin';
};
/** Null on a server older than the in-app Claude sign-in. */
export const useClaudeAuth = () => {
  const api = useApi();
  return useQuery({
    queryKey: ['claude-auth', useOrigin()],
    queryFn: () =>
      api.claudeAuth().catch((e) => (e instanceof ApiError && e.status === 404 ? null : Promise.reject(e))),
  });
};
export const useClaudeModels = (enabled = true) => {
  const api = useApi();
  return useQuery({
    queryKey: ['claude-models', useOrigin()],
    queryFn: () =>
      api.claudeModels().catch((e) => (e instanceof ApiError && e.status === 404 ? [] : Promise.reject(e))),
    enabled,
    staleTime: 5 * 60_000,
  });
};
export const useProviders = () => {
  const api = useApi();
  return useQuery({ queryKey: ['providers', useOrigin()], queryFn: api.providers });
};
export const useProviderModels = (id: string | null) => {
  const api = useApi();
  return useQuery({
    queryKey: ['provider-models', useOrigin(), id],
    queryFn: () => api.providerModels(id!),
    enabled: !!id,
    staleTime: Infinity,
  });
};
export const useApprovals = () => {
  const api = useApi();
  return useQuery({ queryKey: ['approvals', useOrigin()], queryFn: api.approvals });
};
export const useRules = () => {
  const api = useApi();
  return useQuery({ queryKey: ['rules', useOrigin()], queryFn: api.rules });
};
export const useVault = () => {
  const api = useApi();
  return useQuery({ queryKey: ['vault', useOrigin()], queryFn: api.vault });
};
export const useConnections = () => {
  const api = useApi();
  return useQuery({ queryKey: ['connections', useOrigin()], queryFn: api.connections });
};
export const useMemory = () => {
  const api = useApi();
  return useQuery({ queryKey: ['memory', useOrigin()], queryFn: api.memory });
};
/** Under `memory`, so a change to any note brings the list up to date. */
export const useStaleMemory = () => {
  const api = useApi();
  return useQuery({ queryKey: ['memory', useOrigin(), 'stale'], queryFn: api.staleMemory });
};
/** Under `memory` too: memory changes waiting for the person's yes. */
export const useMemoryChanges = () => {
  const api = useApi();
  return useQuery({ queryKey: ['memory', useOrigin(), 'changes'], queryFn: api.memoryChanges });
};
/** Each routine's health over its last 30 days, for routines of bots the person may change. */
export const useRoutineHealth = () => {
  const api = useApi();
  return useQuery({ queryKey: ['routine-health', useOrigin()], queryFn: api.routineHealth });
};
export const useRoutines = () => {
  const api = useApi();
  return useQuery({ queryKey: ['routines', useOrigin()], queryFn: api.routines });
};
export const useSkills = () => {
  const api = useApi();
  return useQuery({ queryKey: ['skills', useOrigin()], queryFn: api.skills });
};
export const useUsage = (days: UsageRange, botId?: string) => {
  const api = useApi();
  return useQuery({
    queryKey: ['usage', useOrigin(), days, botId],
    queryFn: () => api.usage(days, botId),
    staleTime: 30_000,
  });
};
/** How much room the bots' folders take; read from disk, so only while it is on screen. */
export const useStorage = () => {
  const api = useApi();
  return useQuery({ queryKey: ['storage', useOrigin()], queryFn: api.storage, staleTime: 60_000 });
};
export const useToday = () => {
  const api = useApi();
  return useQuery({ queryKey: ['today', useOrigin()], queryFn: api.today });
};
export const useThreads = (botId: string | null | undefined) => {
  const api = useApi();
  return useQuery({
    queryKey: ['threads', useOrigin(), botId],
    queryFn: () => api.threads(botId!),
    enabled: !!botId,
  });
};
export const useMainThread = (botId: string | null | undefined) => {
  const api = useApi();
  return useQuery({
    queryKey: ['main-thread', useOrigin(), botId],
    queryFn: () => api.mainThread(botId!),
    enabled: !!botId,
  });
};
export const useThread = (threadId: string | null | undefined) => {
  const api = useApi();
  return useQuery({
    queryKey: ['thread', useOrigin(), threadId],
    queryFn: () => api.thread(threadId!),
    enabled: !!threadId,
  });
};
export const useMessages = (threadId: string | null | undefined) => {
  const api = useApi();
  return useQuery({
    queryKey: ['messages', useOrigin(), threadId],
    queryFn: () => api.messages(threadId!),
    enabled: !!threadId,
  });
};
export const useJob = (jobId: string | null | undefined) => {
  const api = useApi();
  return useQuery({
    queryKey: ['job', useOrigin(), jobId],
    queryFn: () => api.job(jobId!),
    enabled: !!jobId,
  });
};
export const useLibrary = (botId: string | null | undefined) => {
  const api = useApi();
  return useQuery({
    queryKey: ['library', useOrigin(), botId],
    queryFn: () => api.library(botId!),
    enabled: !!botId,
  });
};
export const useSecondYes = () => {
  const api = useApi();
  return useQuery({ queryKey: ['second-yes', useOrigin()], queryFn: api.secondYes });
};
/** The turns of a conversation that changed something and can be taken back, by turn id. */
export const useTurnChanges = (threadId: string) => {
  const api = useApi();
  return useQuery({
    queryKey: ['turn-changes', useOrigin(), threadId],
    queryFn: () => api.turnChangesPending(threadId),
    // Rarely changes, and only while a turn runs or after one is taken back.
    staleTime: 30_000,
  });
};
export const useRoutineSuggestions = () => {
  const api = useApi();
  return useQuery({ queryKey: ['routine-suggestions', useOrigin()], queryFn: api.routineSuggestions });
};
export const useSkillSuggestions = () => {
  const api = useApi();
  return useQuery({ queryKey: ['skill-suggestions', useOrigin()], queryFn: api.skillSuggestions });
};
export const usePeople = () => {
  const api = useApi();
  return useQuery({ queryKey: ['people', useOrigin()], queryFn: api.people });
};
/** Ways to ask less on one bot, read from the person's answers on its cards. */
export const usePermissionSuggestions = (botId: string) => {
  const api = useApi();
  return useQuery({
    queryKey: ['suggestions', useOrigin(), botId],
    queryFn: () => api.suggestions(botId),
  });
};
export const useBotTables = (botId: string) => {
  const api = useApi();
  return useQuery({ queryKey: ['tables', useOrigin(), botId], queryFn: () => api.botTables(botId) });
};
export const useTableRows = (tableId: string) => {
  const api = useApi();
  return useQuery({ queryKey: ['table-rows', useOrigin(), tableId], queryFn: () => api.tableRows(tableId) });
};
