import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { toast } from '@/components/overlay';
import { PillButton, Row, Section } from '@/components/page';
import { Field } from '@/components/ui';
import { Pad, Rows } from '../common/controls';
import {
  EndpointForm,
  PLAN_ONLY,
  PLANS,
  PlanSignIn,
  POPULAR,
  providerName,
} from '../connect/ProviderConnect';
import { matchesFind } from './data';
import { t } from '@/i18n';
import { useProviders } from '@/lib/queries';
import { useApi, useServer } from '@/lib/server';
import { useColors } from '@/lib/theme';

/** One way to connect something not connected yet. */
type Offer =
  | { kind: 'plan'; key: string; name: string; plan: (typeof PLANS)[number] }
  | { kind: 'key'; key: string; name: string; id: string; popular: boolean }
  | { kind: 'custom'; key: string; name: string };

/**
 * The providers that can still be connected. Plans and the most used providers show first; the
 * rest fold behind one row until asked for or searched. Connecting happens under the row itself.
 */
export function Available({ find }: { find: string }) {
  const { data: providers = [] } = useProviders();
  const [open, setOpen] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  const offers = useMemo(() => {
    const free = providers.filter((p) => !p.configured && !p.custom);
    const plans: Offer[] = PLANS.filter((x) => free.some((p) => p.id === x.provider && p.signIn)).map(
      (plan) => ({ kind: 'plan', key: plan.chip, name: plan.name, plan }),
    );
    const keys = free
      .filter((p) => !PLAN_ONLY.has(p.id))
      .map((p) => ({
        kind: 'key' as const,
        key: p.id,
        name: providerName(p.id),
        id: p.id,
        popular: POPULAR.includes(p.id),
      }))
      .sort((a, b) =>
        a.popular !== b.popular
          ? a.popular
            ? -1
            : 1
          : a.popular
            ? POPULAR.indexOf(a.id) - POPULAR.indexOf(b.id)
            : a.name.localeCompare(b.name),
      );
    return {
      first: [...plans, ...keys.filter((k) => k.popular)] as Offer[],
      rest: keys.filter((k) => !k.popular) as Offer[],
    };
  }, [providers]);
  const custom: Offer = { kind: 'custom', key: '+custom', name: t('provider.custom') };
  const searching = !!find.trim();
  const matches = (o: Offer) => matchesFind(find, `${o.name} ${o.kind === 'key' ? o.id : ''}`);
  const shown = searching
    ? [...offers.first, ...offers.rest, custom].filter(matches)
    : [...offers.first, ...(all ? offers.rest : []), custom];
  const folded = !searching && offers.rest.length > 0;
  if (!shown.length) return null;
  return (
    <Section title={t('providers.available')} footer={t('keys.hint')}>
      <Rows>
        {shown.map((o) => (
          <OfferRow key={o.key} offer={o} open={open === o.key} onOpen={(v) => setOpen(v ? o.key : null)} />
        ))}
        {folded ? (
          <Row
            icon={all ? 'chevron-up' : 'chevron-down'}
            label={all ? t('providers.fewer') : t('providers.more', { count: offers.rest.length })}
            chevron={false}
            onPress={() => setAll(!all)}
          />
        ) : null}
      </Rows>
    </Section>
  );
}

function OfferRow({
  offer: o,
  open,
  onOpen,
}: {
  offer: Offer;
  open: boolean;
  onOpen: (open: boolean) => void;
}) {
  const done = () => {
    toast(t('providers.added', { provider: o.name }));
    onOpen(false);
  };
  const how =
    o.kind === 'plan'
      ? t('providers.how.plan')
      : o.kind === 'key'
        ? t('providers.how.key')
        : t('providers.how.custom');
  return (
    <View>
      <Row
        label={o.name}
        detail={how}
        chevron={false}
        right={
          open ? (
            <PillButton variant="ghost" label={t('common.cancel')} onPress={() => onOpen(false)} />
          ) : (
            <PillButton
              label={o.kind === 'plan' ? t('providers.signIn') : t('providers.connect')}
              onPress={() => onOpen(true)}
            />
          )
        }
      />
      {open ? (
        <Pad>
          {o.kind === 'plan' ? (
            <PlanSignIn plan={o.plan} onDone={() => onOpen(false)} />
          ) : o.kind === 'key' ? (
            <KeyField id={o.id} onSaved={done} />
          ) : (
            <EndpointForm onAdded={() => onOpen(false)} />
          )}
        </Pad>
      ) : null}
    </View>
  );
}

/** Saves a provider's API key; the server keeps it and the app only ever sees its last characters. */
export function KeyField({ id, onSaved }: { id: string; onSaved: () => void }) {
  const c = useColors();
  const api = useApi();
  const { origin } = useServer();
  const qc = useQueryClient();
  const [key, setKey] = useState('');
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () => api.setProviderKey(id, key.trim()),
    onSuccess: () => {
      setKey('');
      setError(null);
      void qc.invalidateQueries({ queryKey: ['providers', origin] });
      void qc.invalidateQueries({ queryKey: ['provider-models', origin, id] });
      onSaved();
    },
    onError: (e) => setError((e as Error).message),
  });
  return (
    <View style={styles.gap}>
      <Field
        value={key}
        onChangeText={(v) => {
          setKey(v);
          setError(null);
        }}
        secureTextEntry
        autoCapitalize="none"
        autoCorrect={false}
        autoFocus
        accessibilityLabel={t('provider.keyFor', { provider: providerName(id) })}
        placeholder={t('provider.keyFor', { provider: providerName(id) })}
      />
      <View style={styles.start}>
        <PillButton
          variant="primary"
          label={t('common.save')}
          onPress={() => key.trim() && save.mutate()}
          busy={save.isPending}
          disabled={!key.trim()}
        />
      </View>
      {error ? <Text style={[styles.small, { color: c.destructive }]}>{error}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  gap: { gap: 12 },
  start: { alignItems: 'flex-start' },
  small: { fontSize: 15, lineHeight: 20 },
});
