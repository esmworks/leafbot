import type { VaultLogin } from '@leafbot/shared';
import Feather from '@expo/vector-icons/Feather';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { confirm, toastError } from '@/components/overlay';
import { Empty, IconButton, Loading, PillButton, Row, Section, SwitchRow } from '@/components/page';
import { InCard } from '@/components/card';
import { Field } from '@/components/ui';
import { ContactDetails } from './ContactDetails';
import { BotSwitches } from './more/BotSwitches';
import { Pad, Rows } from './common/controls';
import { locale, t } from '@/i18n';
import { formatters } from '@/lib/format';
import { useBots, useVault } from '@/lib/queries';
import { useApi, useServer } from '@/lib/server';
import { useColors } from '@/lib/theme';

const fmt = formatters(locale, t);

/** The "vault" settings section's content, under the section's own title bar. */
export function VaultSection() {
  const c = useColors();
  const { data: logins = [], isPending } = useVault();
  const api = useApi();
  const { origin } = useServer();
  const qc = useQueryClient();
  const [query, setQuery] = useState('');
  // A login being edited, or 'new'.
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const q = query.trim().toLowerCase();
  const shown = q ? logins.filter((l) => l.site.includes(q) || l.username.toLowerCase().includes(q)) : logins;
  const remove = useMutation({
    mutationFn: (id: string) => api.removeVaultLogin(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['vault', origin] }),
    onError: toastError,
  });
  return (
    <>
      <View style={styles.search}>
        <Feather name="search" size={20} color={c.mutedForeground} style={styles.searchIcon} />
        <Field
          value={query}
          onChangeText={setQuery}
          autoCapitalize="none"
          autoCorrect={false}
          placeholder={t('vault.search')}
          accessibilityLabel={t('vault.search')}
          style={[styles.grow, styles.searchField]}
        />
        <PillButton
          variant="primary"
          size="large"
          icon="plus"
          label={t('common.add')}
          onPress={() => setEditing('new')}
        />
      </View>
      {editing === 'new' ? <LoginForm onDone={() => setEditing(null)} /> : null}
      <Section footer={t('vault.note')}>
        {isPending ? (
          <Loading />
        ) : shown.length === 0 ? (
          <Empty icon="key" text={q ? t('vault.noMatch') : t('vault.empty')} />
        ) : (
          <Rows>
            {shown.map((l) =>
              editing === l.id ? (
                <Pad key={l.id}>
                  <LoginForm login={l} onDone={() => setEditing(null)} />
                </Pad>
              ) : (
                <Row
                  key={l.id}
                  label={l.site}
                  detail={[
                    l.username || t('vault.noUsername'),
                    l.hasTotp ? t('vault.hasTotp') : null,
                    l.botIds ? t('vault.someBots', { count: l.botIds.length }) : null,
                    l.lastUsedAt ? t('vault.lastUsed', { when: fmt.dayLabel(l.lastUsedAt) }) : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                  right={
                    <View style={styles.actions}>
                      <IconButton
                        icon="edit-2"
                        size={18}
                        label={t('vault.edit')}
                        onPress={() => setEditing(l.id)}
                      />
                      <IconButton
                        icon="trash-2"
                        size={18}
                        label={t('common.delete')}
                        onPress={async () => {
                          if (
                            await confirm({
                              title: t('vault.confirmDelete', { site: l.site }),
                              destructive: true,
                              confirmLabel: t('common.delete'),
                            })
                          )
                            remove.mutate(l.id);
                        }}
                      />
                    </View>
                  }
                />
              ),
            )}
          </Rows>
        )}
      </Section>
      <ContactDetails />
    </>
  );
}

/** Adds a sign-in, or edits one; the password is only sent when typed. */
function LoginForm({ login, onDone }: { login?: VaultLogin; onDone: () => void }) {
  const api = useApi();
  const { origin } = useServer();
  const qc = useQueryClient();
  const c = useColors();
  const { data: bots = [] } = useBots();
  const [site, setSite] = useState(login?.site ?? '');
  const [username, setUsername] = useState(login?.username ?? '');
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [clearTotp, setClearTotp] = useState(false);
  // Null: every bot may use it.
  const [botIds, setBotIds] = useState<string[] | null>(login?.botIds ?? null);
  const save = useMutation({
    mutationFn: () =>
      login
        ? api.updateVaultLogin(login.id, {
            site,
            username,
            botIds,
            ...(password && { password }),
            ...(totp.trim() ? { totp: totp.trim() } : clearTotp ? { totp: '' } : {}),
          })
        : api.addVaultLogin({ site, username, password, botIds, ...(totp.trim() && { totp: totp.trim() }) }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['vault', origin] });
      onDone();
    },
    onError: toastError,
  });
  const ready = !!site.trim() && (!!login || !!password) && !save.isPending;
  // The new-login form draws its own card; its fields take the in-card look like an edited row's.
  return (
    <InCard.Provider value>
      <View
        style={[
          styles.form,
          !login && {
            backgroundColor: c.card,
            borderColor: c.border,
            borderWidth: StyleSheet.hairlineWidth,
            borderRadius: 16,
            padding: 16,
          },
        ]}
      >
        <Field
          value={site}
          onChangeText={setSite}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          placeholder={t('vault.site')}
          accessibilityLabel={t('vault.site')}
        />
        <Field
          value={username}
          onChangeText={setUsername}
          autoCapitalize="none"
          autoCorrect={false}
          placeholder={t('vault.username')}
          accessibilityLabel={t('vault.username')}
        />
        <Field
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          textContentType="newPassword"
          placeholder={login ? t('vault.newPassword') : t('vault.password')}
          accessibilityLabel={t('vault.password')}
        />
        <Field
          value={totp}
          onChangeText={setTotp}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          placeholder={login?.hasTotp && !clearTotp ? t('vault.totpKept') : t('vault.totp')}
          accessibilityLabel={t('vault.totp')}
        />
        {login?.hasTotp ? (
          <View style={[styles.box, { borderColor: c.border, backgroundColor: c.muted }]}>
            <SwitchRow label={t('vault.totpRemove')} value={clearTotp} onChange={setClearTotp} />
          </View>
        ) : null}
        <View style={[styles.box, { borderColor: c.border, backgroundColor: c.muted }]}>
          <SwitchRow
            label={t('vault.allBots')}
            value={botIds === null}
            onChange={(on) => setBotIds(on ? null : [])}
          />
        </View>
        {botIds !== null && bots.length > 0 ? (
          <BotSwitches
            bots={bots}
            on={(id) => botIds.includes(id)}
            onChange={(id, on) =>
              setBotIds((ids) => (on ? [...(ids ?? []), id] : (ids ?? []).filter((x) => x !== id)))
            }
          />
        ) : null}
        <View style={styles.buttons}>
          <PillButton variant="ghost" label={t('common.cancel')} onPress={onDone} />
          <PillButton
            variant="primary"
            label={t('common.save')}
            onPress={() => save.mutate()}
            busy={save.isPending}
            disabled={!ready}
          />
        </View>
      </View>
    </InCard.Provider>
  );
}

const styles = StyleSheet.create({
  search: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  grow: { flex: 1 },
  searchIcon: { position: 'absolute', left: 14, zIndex: 1 },
  searchField: { paddingLeft: 38 },
  actions: { flexDirection: 'row' },
  form: { gap: 10 },
  box: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, overflow: 'hidden' },
  buttons: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8 },
});
