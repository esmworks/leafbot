import { Redirect, router } from 'expo-router';
import { Page, Row, Section } from '@/components/page';
import { Hint, Rows } from '@/components/settings/common/controls';
import { t } from '@/i18n';
import { useServer } from '@/lib/server';

/**
 * The servers of the person's account, one to open. The choice is remembered; an account with a
 * single server never shows this screen, and Settings brings it back for those with several.
 */
export default function Servers() {
  const { ready, phase, servers, server, choose, refresh } = useServer();
  if (ready && (phase === 'signedOut' || phase === 'loading')) return <Redirect href="/" />;
  const pick = async (id: string) => {
    await choose(id);
    // Start over from the first screen, which opens the tunnel to the chosen server.
    if (router.canDismiss()) router.dismissAll();
    router.replace('/');
  };
  return (
    <Page
      title={t('servers.title')}
      onBack={() => (router.canGoBack() ? router.back() : router.replace('/'))}
    >
      <Hint>{t('servers.intro')}</Hint>
      <Section>
        <Rows>
          {servers.map((s) => (
            <Row
              key={s.id}
              icon={server?.id === s.id ? 'check' : 'server'}
              label={s.name}
              detail={t(`people.role.${s.role}`)}
              onPress={() => void pick(s.id)}
            />
          ))}
          <Row icon="refresh-cw" label={t('common.retry')} chevron={false} onPress={refresh} />
        </Rows>
      </Section>
    </Page>
  );
}
