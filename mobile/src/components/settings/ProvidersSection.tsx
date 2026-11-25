import type { ProviderInfo } from '@leafbot/shared';
import { useState } from 'react';
import { Row, Section } from '@/components/page';
import { Field } from '@/components/ui';
import { Hint, Pad, Rows, Status } from './common/controls';
import { useSectionBack } from './common/sectionBack';
import { connectionName } from './connect/ProviderConnect';
import { Available } from './providers/Available';
import {
  CLAUDE,
  claudeState,
  matchesFind,
  reachText,
  useBotCount,
  useClaudeStatus,
  useProviderModelInfo,
  useRoleText,
} from './providers/data';
import { BackupModel, NewBotsRow } from './providers/Defaults';
import { ProviderPage } from './providers/ProviderPage';
import { t } from '@/i18n';
import { useClaudeAuth, useProviders, useSettings } from '@/lib/queries';

/**
 * The "providers" settings section's content: what new bots start with, the AI providers already
 * connected and the ones that can be. A connected provider opens to its own page, kept here as
 * state; the title bar's back arrow closes it before it leaves the section.
 */
export function ProvidersSection() {
  const { data: providers, isLoading } = useProviders();
  const [view, setView] = useState<string | null>(null);
  const known = view === CLAUDE || !!providers?.some((p) => p.id === view && p.configured);
  // A provider whose last key or sign-in was just removed has no page left: the list shows instead.
  const open = view && (known || isLoading) ? view : null;
  useSectionBack(open !== null, () => setView(null));
  if (open && known) return <ProviderPage id={open} />;
  return <ProviderList onOpen={setView} />;
}

function ProviderList({ onOpen }: { onOpen: (id: string) => void }) {
  const { data: settings } = useSettings();
  const { data: providers = [] } = useProviders();
  const [find, setFind] = useState('');
  const connected = providers.filter((p) => p.configured);
  const claudeShown = matchesFind(find, `${t('ai.claude')} ${CLAUDE}`);
  const connectedShown = connected.filter((p) => matchesFind(find, `${connectionName(p)} ${p.id}`));
  return (
    <>
      {settings?.defaultEngine !== undefined || settings?.backupModel !== undefined ? (
        <Section title={t('providers.defaults')}>
          <Rows>
            {settings?.defaultEngine !== undefined ? (
              <NewBotsRow onOpenClaude={() => onOpen(CLAUDE)} />
            ) : null}
            {settings?.backupModel !== undefined ? <BackupModel /> : null}
          </Rows>
        </Section>
      ) : null}
      <Section title={t('providers.connected')}>
        <Rows>
          <Pad>
            <Field
              value={find}
              onChangeText={setFind}
              autoCapitalize="none"
              autoCorrect={false}
              placeholder={t('providers.search')}
              accessibilityLabel={t('providers.search')}
            />
          </Pad>
          {claudeShown ? <ClaudeRow onOpen={() => onOpen(CLAUDE)} /> : null}
          {connectedShown.map((p) => (
            <ConnectedRow key={p.id} provider={p} onOpen={() => onOpen(p.id)} />
          ))}
          {!claudeShown && !connectedShown.length ? (
            <Pad>
              <Hint>{t('providers.noMatch', { query: find.trim() })}</Hint>
            </Pad>
          ) : null}
        </Rows>
      </Section>
      <Available find={find} />
    </>
  );
}

function ClaudeRow({ onOpen }: { onOpen: () => void }) {
  const { status, detail } = useClaudeStatus();
  const { data: auth } = useClaudeAuth();
  const bots = useBotCount(CLAUDE);
  const roles = useRoleText(CLAUDE);
  return (
    <Row
      label={t('ai.claude')}
      detail={[
        roles,
        auth === null ? t('connection.defaultHint') : detail,
        bots > 0 && t('providers.bots', { count: bots }),
      ]
        .filter(Boolean)
        .join(' · ')}
      right={<Status state={claudeState(status)} label={t(`connection.status.${status}`)} />}
      onPress={onOpen}
    />
  );
}

function ConnectedRow({ provider: p, onOpen }: { provider: ProviderInfo; onOpen: () => void }) {
  const bots = useBotCount(p.id);
  const roles = useRoleText(p.id);
  const { data: models } = useProviderModelInfo(p.id);
  return (
    <Row
      label={connectionName(p)}
      detail={[
        roles,
        reachText(p),
        models && t('provider.foundModels', { count: models.length }),
        bots > 0 && t('providers.bots', { count: bots }),
      ]
        .filter(Boolean)
        .join(' · ')}
      right={<Status state="ok" label={t('connection.status.ok')} />}
      onPress={onOpen}
    />
  );
}
