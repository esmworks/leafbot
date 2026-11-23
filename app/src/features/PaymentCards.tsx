import { cardBrand, luhn, type CardBrand, type PaymentCard } from '@leafbot/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CreditCard, Plus, Trash2, X } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useT } from '@/i18n';
import { api } from '@/lib/api';
import { parseExpiry } from '@/lib/cardExpiry';
import { useFormat } from '@/lib/format';
import { useManagesServer } from '@/lib/queries';
import { BotAccess, TeamChoice } from './VaultTab';

/** The networks' own names, the same in every language; a card of another kind is called a card. */
const BRANDS: Record<Exclude<CardBrand, 'other'>, string> = {
  visa: 'Visa',
  mastercard: 'Mastercard',
  amex: 'American Express',
  troy: 'Troy',
  discover: 'Discover',
};

/**
 * Payment cards a bot may fill into a checkout page, for the person they belong to and only while
 * they are in the conversation. The number is never shown again once saved.
 */
export function PaymentCards() {
  const t = useT();
  const { data: cards = [] } = useQuery({ queryKey: ['vault', 'cards'], queryFn: api.cards });
  const [adding, setAdding] = useState(false);
  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between gap-2 px-1">
        <div>
          <div className="text-sm font-medium">{t('cards.title')}</div>
          <p className="text-xs text-muted-foreground">{t('cards.hint')}</p>
        </div>
        {!adding && (
          <Button variant="secondary" className="rounded-full" onClick={() => setAdding(true)}>
            <Plus /> {t('common.add')}
          </Button>
        )}
      </div>
      {adding && <CardForm onDone={() => setAdding(false)} />}
      {cards.length > 0 && (
        <div className="divide-y rounded-2xl border bg-card/50">
          {cards.map((c) => (
            <CardRow key={c.id} card={c} />
          ))}
        </div>
      )}
    </section>
  );
}

function CardRow({ card: c }: { card: PaymentCard }) {
  const t = useT();
  const { dayLabel } = useFormat();
  const qc = useQueryClient();
  const manages = useManagesServer();
  const mayChange = manages || !!c.userId;
  const done = () => qc.invalidateQueries({ queryKey: ['vault', 'cards'] });
  const remove = useMutation({
    mutationFn: () => api.removeCard(c.id),
    onSuccess: done,
    onError: (e) => toast.error((e as Error).message),
  });
  const forget = useMutation({
    mutationFn: (site: string) => api.updateCard(c.id, { forgetSites: [site] }),
    onSuccess: done,
    onError: (e) => toast.error((e as Error).message),
  });
  const brand = c.brand === 'other' ? t('cards.card') : BRANDS[c.brand];
  return (
    <div className="space-y-2 px-4 py-3">
      <div className="flex items-center gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-xl border bg-background text-muted-foreground">
          <CreditCard className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">
            {c.label ? `${c.label} · ` : ''}
            {brand} •••• {c.last4}
          </div>
          <div className="truncate text-xs text-muted-foreground">
            {t('cards.expires', { month: String(c.expMonth).padStart(2, '0'), year: String(c.expYear) })}
            {` · ${c.userId === null ? t('owned.team') : t('owned.yours')}`}
            {c.botIds ? ` · ${t('vault.someBots', { count: c.botIds.length })}` : ''}
            {c.lastUsedAt ? ` · ${t('vault.lastUsed', { when: dayLabel(c.lastUsedAt) })}` : ''}
          </div>
        </div>
        {mayChange && (
          <Button
            variant="ghost"
            size="icon"
            className="rounded-full"
            disabled={remove.isPending}
            onClick={() => {
              if (confirm(t('cards.confirmDelete', { card: `${brand} •••• ${c.last4}` }))) remove.mutate();
            }}
            aria-label={t('common.delete')}
          >
            <Trash2 />
          </Button>
        )}
      </div>
      {c.sites.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 ps-12 text-xs text-muted-foreground">
          <span>{t('cards.sites')}</span>
          {c.sites.map((site) => (
            <span key={site} className="inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5">
              {site}
              {mayChange && (
                <button
                  type="button"
                  className="text-muted-foreground hover:text-foreground"
                  onClick={() => forget.mutate(site)}
                  aria-label={t('cards.forgetSite', { site })}
                >
                  <X className="size-3" />
                </button>
              )}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function CardForm({ onDone }: { onDone(): void }) {
  const t = useT();
  const qc = useQueryClient();
  const manages = useManagesServer();
  const [label, setLabel] = useState('');
  const [number, setNumber] = useState('');
  const [expiry, setExpiry] = useState('');
  const [cvc, setCvc] = useState('');
  const [holder, setHolder] = useState('');
  const [botIds, setBotIds] = useState<string[] | null>(null);
  const [team, setTeam] = useState(false);
  const digits = number.replace(/[\s-]/g, '');
  const valid = /^\d{12,19}$/.test(digits) && luhn(digits);
  const exp = parseExpiry(expiry);
  const save = useMutation({
    mutationFn: () =>
      api.addCard({
        label: label.trim(),
        number: digits,
        expMonth: exp!.month,
        expYear: exp!.year,
        ...(cvc.trim() && { cvc: cvc.trim() }),
        ...(holder.trim() && { holder: holder.trim() }),
        botIds,
        ...(manages && team && { team }),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['vault', 'cards'] });
      onDone();
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate();
  };
  const brand = valid ? cardBrand(digits) : null;
  return (
    <form onSubmit={submit} className="space-y-3 rounded-2xl border bg-background p-3">
      <Input
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        placeholder={t('cards.label')}
        aria-label={t('cards.label')}
      />
      <div className="relative">
        <Input
          value={number}
          onChange={(e) => setNumber(e.target.value)}
          placeholder={t('cards.number')}
          aria-label={t('cards.number')}
          inputMode="numeric"
          autoComplete="off"
          aria-invalid={digits.length >= 12 && !valid}
        />
        {brand && brand !== 'other' && (
          <span className="pointer-events-none absolute top-1/2 end-3 -translate-y-1/2 text-xs text-muted-foreground">
            {BRANDS[brand]}
          </span>
        )}
      </div>
      {digits.length >= 12 && !valid && (
        <p className="text-xs text-destructive">{t('cards.invalidNumber')}</p>
      )}
      <div className="flex gap-2">
        <Input
          value={expiry}
          onChange={(e) => setExpiry(e.target.value)}
          placeholder={t('cards.expiry')}
          aria-label={t('cards.expiry')}
          inputMode="numeric"
          autoComplete="off"
          className="w-32"
        />
        <Input
          type="password"
          value={cvc}
          onChange={(e) => setCvc(e.target.value)}
          placeholder={t('cards.cvc')}
          aria-label={t('cards.cvc')}
          inputMode="numeric"
          autoComplete="off"
          className="w-32"
        />
        <Input
          value={holder}
          onChange={(e) => setHolder(e.target.value)}
          placeholder={t('cards.holder')}
          aria-label={t('cards.holder')}
          autoComplete="off"
        />
      </div>
      <p className="text-xs text-muted-foreground">{t('cards.formHint')}</p>
      <BotAccess botIds={botIds} onChange={setBotIds} />
      {manages && <TeamChoice team={team} onChange={setTeam} />}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" className="rounded-full" onClick={onDone}>
          {t('common.cancel')}
        </Button>
        <Button type="submit" className="rounded-full" disabled={!valid || !exp || save.isPending}>
          {t('common.save')}
        </Button>
      </div>
    </form>
  );
}
