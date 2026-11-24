import type { ContactDetails as Contact, ContactPart } from '@leafbot/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Contact as ContactIcon, Pencil, Plus, Trash2, X } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useT } from '@/i18n';
import { api } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { useManagesServer } from '@/lib/queries';
import { BotAccess, TeamChoice } from './VaultTab';

const KEY = ['vault', 'contacts'];

/** A name for the details: the one given them, or the person's name. */
const nameOf = (c: Contact) => c.label || [c.givenName, c.familyName].filter(Boolean).join(' ');

/**
 * A name, an email, a phone and an address a bot fills into a form (a delivery address, a sign-up)
 * on a site the person agreed to. Unlike a card the person sees them whole and changes them here.
 */
export function ContactDetails() {
  const t = useT();
  const { data: contacts = [] } = useQuery({ queryKey: KEY, queryFn: api.contacts });
  const [editing, setEditing] = useState<Contact | 'new' | null>(null);
  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between gap-2 px-1">
        <div>
          <div className="text-sm font-medium">{t('contacts.title')}</div>
          <p className="text-xs text-muted-foreground">{t('contacts.hint')}</p>
        </div>
        {editing !== 'new' && (
          <Button variant="secondary" className="rounded-full" onClick={() => setEditing('new')}>
            <Plus /> {t('common.add')}
          </Button>
        )}
      </div>
      {editing === 'new' && <ContactForm onDone={() => setEditing(null)} />}
      {contacts.length > 0 && (
        <div className="divide-y rounded-2xl border bg-card/50">
          {contacts.map((c) =>
            editing !== 'new' && editing?.id === c.id ? (
              <div key={c.id} className="p-3">
                <ContactForm contact={c} onDone={() => setEditing(null)} />
              </div>
            ) : (
              <ContactRow key={c.id} contact={c} onEdit={() => setEditing(c)} />
            ),
          )}
        </div>
      )}
    </section>
  );
}

function ContactRow({ contact: c, onEdit }: { contact: Contact; onEdit(): void }) {
  const t = useT();
  const { dayLabel } = useFormat();
  const qc = useQueryClient();
  const manages = useManagesServer();
  // The team's are changed only by those who look after the server.
  const mayChange = manages || !!c.userId;
  const done = () => qc.invalidateQueries({ queryKey: KEY });
  const remove = useMutation({
    mutationFn: () => api.removeContact(c.id),
    onSuccess: done,
    onError: (e) => toast.error((e as Error).message),
  });
  const forget = useMutation({
    mutationFn: (site: string) => api.updateContact(c.id, { forgetSites: [site] }),
    onSuccess: done,
    onError: (e) => toast.error((e as Error).message),
  });
  const name = nameOf(c) || c.email || t('contacts.unnamed');
  const person = [c.givenName, c.familyName].filter(Boolean).join(' ');
  const place = [c.city, c.region, c.country].filter(Boolean).join(', ');
  return (
    <div className="space-y-2 px-4 py-3">
      <div className="flex items-center gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-xl border bg-background text-muted-foreground">
          <ContactIcon className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">
            {name}
            {c.label && person && <span className="font-normal text-muted-foreground"> · {person}</span>}
          </div>
          <div className="truncate text-xs text-muted-foreground">
            {[c.email, c.phone, place].filter(Boolean).join(' · ')}
          </div>
          <div className="truncate text-xs text-muted-foreground">
            {c.userId === null ? t('owned.team') : t('owned.yours')}
            {c.botIds ? ` · ${t('vault.someBots', { count: c.botIds.length })}` : ''}
            {c.lastUsedAt ? ` · ${t('vault.lastUsed', { when: dayLabel(c.lastUsedAt) })}` : ''}
          </div>
        </div>
        {mayChange && (
          <>
            <Button
              variant="ghost"
              size="icon"
              className="rounded-full"
              onClick={onEdit}
              aria-label={t('vault.edit')}
            >
              <Pencil />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="rounded-full"
              disabled={remove.isPending}
              onClick={() => {
                if (confirm(t('contacts.confirmDelete', { name }))) remove.mutate();
              }}
              aria-label={t('common.delete')}
            >
              <Trash2 />
            </Button>
          </>
        )}
      </div>
      {c.sites.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 ps-12 text-xs text-muted-foreground">
          <span>{t('contacts.sites')}</span>
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

/** The form's fields in the order a person fills them, each with the browser's autofill name. */
const FIELDS: { part: ContactPart; auto: string; type?: string; wide?: boolean }[] = [
  { part: 'givenName', auto: 'given-name' },
  { part: 'familyName', auto: 'family-name' },
  { part: 'email', auto: 'email', type: 'email' },
  { part: 'phone', auto: 'tel', type: 'tel' },
  { part: 'organization', auto: 'organization', wide: true },
  { part: 'address1', auto: 'address-line1', wide: true },
  { part: 'address2', auto: 'address-line2', wide: true },
  { part: 'city', auto: 'address-level2' },
  { part: 'region', auto: 'address-level1' },
  { part: 'postalCode', auto: 'postal-code' },
  { part: 'country', auto: 'country-name' },
];

type Values = Record<ContactPart, string>;

function ContactForm({ contact, onDone }: { contact?: Contact; onDone(): void }) {
  const t = useT();
  const qc = useQueryClient();
  const manages = useManagesServer();
  const [label, setLabel] = useState(contact?.label ?? '');
  const [values, setValues] = useState<Values>(
    () => Object.fromEntries(FIELDS.map((f) => [f.part, contact?.[f.part] ?? ''])) as Values,
  );
  const [botIds, setBotIds] = useState<string[] | null>(contact?.botIds ?? null);
  const [team, setTeam] = useState(contact ? contact.userId === null : false);
  const trimmed = Object.fromEntries(FIELDS.map((f) => [f.part, values[f.part].trim()])) as Values;
  const filled = FIELDS.some((f) => trimmed[f.part]);
  const save = useMutation({
    mutationFn: () =>
      contact
        ? api.updateContact(contact.id, {
            label: label.trim(),
            ...trimmed,
            botIds,
            ...(manages && { team }),
          })
        : api.addContact({ label: label.trim(), ...trimmed, botIds, ...(manages && team && { team }) }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: KEY });
      onDone();
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate();
  };
  return (
    <form onSubmit={submit} className="space-y-3 rounded-2xl border bg-background p-3">
      <Input
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        placeholder={t('contacts.label')}
        aria-label={t('contacts.label')}
        autoComplete="off"
      />
      <div className="grid gap-2 sm:grid-cols-2">
        {FIELDS.map((f) => (
          <Input
            key={f.part}
            type={f.type ?? 'text'}
            value={values[f.part]}
            onChange={(e) => setValues((v) => ({ ...v, [f.part]: e.target.value }))}
            placeholder={t(`contacts.field.${f.part}`)}
            aria-label={t(`contacts.field.${f.part}`)}
            autoComplete={f.auto}
            className={f.wide ? 'sm:col-span-2' : undefined}
          />
        ))}
      </div>
      <BotAccess botIds={botIds} onChange={setBotIds} />
      {manages && <TeamChoice team={team} onChange={setTeam} />}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" className="rounded-full" onClick={onDone}>
          {t('common.cancel')}
        </Button>
        <Button type="submit" className="rounded-full" disabled={!filled || save.isPending}>
          {t('common.save')}
        </Button>
      </div>
    </form>
  );
}
