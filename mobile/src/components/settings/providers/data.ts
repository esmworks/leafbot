import { newBotEngine, type ModelInfo, type ProviderInfo } from '@leafbot/shared';
import { settingsMatch } from '@leafbot/app/src/lib/settingsMatch';
import { useQuery } from '@tanstack/react-query';
import { splitPiModel } from '../connect/ProviderConnect';
import { t } from '@/i18n';
import { ApiError } from '@/lib/api';
import { useBots, useClaudeAuth, useInfo, useSettings } from '@/lib/queries';
import { useApi, useServer } from '@/lib/server';

/** Claude's place among the providers; never a provider id, which the server names in lowercase words. */
export const CLAUDE = 'claude';

/**
 * A provider's models with their names and what they can do. A server older than the model list
 * answers 404; its plain ids then stand in, with the rest unknown.
 */
export const useProviderModelInfo = (id: string | null) => {
  const api = useApi();
  const { origin } = useServer();
  return useQuery({
    // Under `provider-models` so a refresh of the provider's models brings this list up to date too.
    queryKey: ['provider-models', origin, id, 'info'],
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
};

/** How many bots run on Claude, or on a model of the given provider. */
export function useBotCount(id: string) {
  const { data: bots = [] } = useBots();
  return bots.filter((b) =>
    id === CLAUDE ? b.engine === 'claude' : b.engine === 'pi' && b.model.startsWith(`${id}/`),
  ).length;
}

/** What a provider is used for: the start of new bots, the backup model, or both. */
export function useRoles(id: string) {
  const { data: settings } = useSettings();
  const target = newBotEngine(settings);
  const backup = settings?.backupModel ? splitPiModel(settings.backupModel).provider : '';
  return {
    newBots:
      id === CLAUDE
        ? target.engine === 'claude'
        : target.engine === 'pi' && target.model.startsWith(`${id}/`),
    backup: id !== CLAUDE && backup === id,
  };
}

/** The roles as words, for the line under a provider's name. */
export function useRoleText(id: string): string {
  const roles = useRoles(id);
  return [roles.newBots && t('providers.role.newBots'), roles.backup && t('providers.role.backup')]
    .filter(Boolean)
    .join(' · ');
}

/** Claude's state as the list and its page show it. */
export function useClaudeStatus() {
  const { data: info } = useInfo();
  const { data: auth } = useClaudeAuth();
  const status = info?.claude.status ?? 'unknown';
  const detail =
    auth?.kind === 'token'
      ? t('claude.usingToken', { hint: auth.hint ?? '' })
      : auth?.kind === 'apiKey'
        ? auth.baseUrl
          ? t('claude.usingGateway', { hint: auth.hint ?? '', url: auth.baseUrl })
          : t('claude.usingApiKey', { hint: auth.hint ?? '' })
        : t('claude.usingLogin');
  return { status, detail };
}

/** Claude's state in the words `Status` takes. */
export const claudeState = (status: string): 'ok' | 'problem' | 'unknown' =>
  status === 'ok' ? 'ok' : status === 'unknown' ? 'unknown' : 'problem';

/** How a connected provider is reached, in a few words: its plan, its key, or its address. */
export function reachText(p: ProviderInfo): string {
  if (p.custom) return p.custom.baseUrl;
  return [
    p.signIn?.signedIn ? t('provider.signedIn') : '',
    p.hint ? t('providers.keyHint', { hint: p.hint }) : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

/** The search box's test: every word typed is in the text, ignoring case and accents. */
export const matchesFind = settingsMatch;
