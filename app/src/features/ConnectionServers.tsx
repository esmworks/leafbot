import { LogOut, Plus } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { useT, type MessageKey } from '@/i18n';
import { desktop } from '@/lib/desktop';
import { useFormat } from '@/lib/format';
import { useInfo, useManagesServer } from '@/lib/queries';
import { useServerSwitch, type ServerChoice, type ServerRole } from '@/lib/serverSwitch';
import { useUi } from '@/lib/store';
import { ConnectPhone } from './ConnectPhone';
import { ApnsCard } from './PhoneSettings';
import { Heading, ListRow, Mark, PageHead, Status, Tag } from './SettingsList';
import { Card, Row, ServerEnvironment } from './SettingsPage';
import { TailscaleCard } from './TailscaleSettings';

const ROLE_LABEL: Record<ServerRole, MessageKey> = {
  owner: 'bots.role.owner',
  admin: 'bots.role.admin',
  member: 'bots.role.member',
};

/** Opens a server's page in the connection settings, or the list with null. */
const show = (id: string | null) => useUi.setState({ settingsView: id });

/**
 * The connection settings reached through the account: the account's servers, one line each, and
 * what belongs to the account rather than a server (signing in another device, signing out).
 *
 * A server's own settings come from that server, over the one tunnel this page has, so only the
 * server open in this window opens to its page here. Choosing another moves the window to it, as
 * the sidebar does, and its page opens there. With a single server there is nothing to choose
 * from, and its page shows at once.
 */
export function AccountConnection() {
  const { servers, choose, add } = useServerSwitch();
  const view = useUi((s) => s.settingsView);
  const list = servers ?? [];
  const current = list.find((s) => s.current);
  if (list.length <= 1)
    return (
      <>
        <ServerPage onAdd={add} />
        <AccountCards />
      </>
    );
  if (current && view === current.id) return <ServerPage />;
  return (
    <>
      <ServerList servers={list} choose={choose} add={add} />
      <AccountCards />
    </>
  );
}

/** The open server's name, for the settings title while its page shows among several. */
export function useConnectionTitle(view: string | null): string | null {
  const { servers } = useServerSwitch();
  const current = servers?.find((s) => s.current);
  return view && servers && servers.length > 1 && current?.id === view ? current.name : null;
}

function AddServer({ onAdd }: { onAdd(): void }) {
  const t = useT();
  return (
    <Button variant="secondary" size="sm" className="rounded-full" onClick={onAdd}>
      <Plus /> {t('connection.addServer')}
    </Button>
  );
}

function ServerList({
  servers,
  choose,
  add,
}: {
  servers: ServerChoice[];
  choose?: (id: string) => void;
  add?: () => void;
}) {
  const t = useT();
  const { dayLabel } = useFormat();
  const { data: info } = useInfo();
  return (
    <section className="mb-6">
      <Heading title={t('connection.servers')} hint={t('connection.serversHint')}>
        {add && <AddServer onAdd={add} />}
      </Heading>
      <div className="divide-y rounded-2xl border bg-card/50">
        {servers.map((s) => (
          <ListRow
            key={s.id}
            name={s.name}
            mark={<Mark name={s.name} endpoint />}
            // Only the open server is known to answer; the account says when the others last did.
            status={s.current ? <Status health="ok" /> : undefined}
            tags={
              <>
                {s.role && <Tag>{t(ROLE_LABEL[s.role])}</Tag>}
                {s.current && <Tag>{t('connection.shownHere')}</Tag>}
              </>
            }
            detail={[
              s.current
                ? info?.version && t('connection.versionLine', { version: info.version })
                : !!s.seenAt &&
                  t('connection.lastSeen', { when: dayLabel(new Date(s.seenAt).toISOString()) }),
            ]}
            onOpen={() => {
              // The page is asked for first, so the next server opens to it once it is there.
              show(s.id);
              if (!s.current) choose?.(s.id);
            }}
          />
        ))}
      </div>
    </section>
  );
}

/** The open server's page: where its bots run, how this page reaches it, and its own add-ons. */
function ServerPage({ onAdd }: { onAdd?: () => void }) {
  const t = useT();
  const { name, role } = useServerSwitch();
  const { data: info } = useInfo();
  const manages = useManagesServer();
  return (
    <>
      <PageHead
        name={name}
        mark={<Mark name={name} endpoint large />}
        status={<Status health="ok" />}
        tags={role && <Tag>{t(ROLE_LABEL[role])}</Tag>}
        line={info?.version ? t('connection.versionLine', { version: info.version }) : null}
      >
        {onAdd && <AddServer onAdd={onAdd} />}
      </PageHead>
      {manages && <ServerEnvironment />}
      <Card title={t('connection.server')}>
        <Row label={t('connection.how')} hint={t('connection.viaAccount')} />
      </Card>
      <TailscaleCard />
      {manages && <ApnsCard />}
    </>
  );
}

/** What belongs to the person's account rather than to a server. */
function AccountCards() {
  const t = useT();
  return (
    <>
      <ConnectPhone owner={false} />
      {desktop?.account?.signOut && (
        <Card title={t('accountHost.title')}>
          <AccountSignOutRow signOut={desktop.account.signOut} />
        </Card>
      )}
    </>
  );
}

/**
 * In the desktop app, signing out of the Leaf Bot account, which its menu bar offers too. On the
 * website the page has no account sign-out it can call, so there is nothing here; ending the tunnel
 * alone would only leave the page signed out of this server.
 */
function AccountSignOutRow({ signOut }: { signOut(): Promise<void> }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  return (
    <Row label={t('connection.accountSignOut')} hint={t('connection.accountSignOutHint')}>
      <Button
        variant="secondary"
        size="sm"
        className="rounded-full"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          void signOut().finally(() => setBusy(false));
        }}
      >
        <LogOut /> {t('connection.logout')}
      </Button>
    </Row>
  );
}
