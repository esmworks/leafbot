import type { ApnsSet } from '@leafbot/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FileUp } from 'lucide-react';
import { useRef, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { useT } from '@/i18n';
import { api } from '@/lib/api';
import { Card, Row } from './SettingsPage';

const useApns = () => useQuery({ queryKey: ['apns'], queryFn: api.apns });

/**
 * The Apple key that lets this server notify the iPhone app. A self-hosted server sends straight
 * to Apple, so the key belongs to whoever built and installed the app.
 */
export function ApnsCard() {
  const t = useT();
  const qc = useQueryClient();
  const { data: apns } = useApns();
  const [editing, setEditing] = useState(false);
  const done = (status: unknown) => {
    qc.setQueryData(['apns'], status);
    setEditing(false);
  };
  const clear = useMutation({
    mutationFn: api.clearApns,
    onSuccess: done,
    onError: (e) => toast.error((e as Error).message),
  });
  if (!apns) return null;
  return (
    <Card title={t('apns.title')}>
      <Row
        label={t('apns.key')}
        hint={
          apns.configured
            ? t('apns.configured', {
                team: apns.teamId ?? '',
                key: apns.keyId ?? '',
                bundle: apns.bundleId ?? '',
              })
            : t('apns.hint')
        }
      >
        {!editing && (
          <Button variant="secondary" size="sm" className="rounded-full" onClick={() => setEditing(true)}>
            {apns.configured ? t('apns.change') : t('apns.add')}
          </Button>
        )}
        {apns.configured && !editing && (
          <Button
            variant="ghost"
            size="sm"
            className="rounded-full"
            disabled={clear.isPending}
            onClick={() => clear.mutate()}
          >
            {t('apns.remove')}
          </Button>
        )}
      </Row>
      {editing && (
        <ApnsForm
          initial={{ teamId: apns.teamId ?? '', keyId: apns.keyId ?? '', bundleId: apns.bundleId ?? '' }}
          onSaved={done}
          onCancel={() => setEditing(false)}
        />
      )}
    </Card>
  );
}

function ApnsForm({
  initial,
  onSaved,
  onCancel,
}: {
  initial: Omit<ApnsSet, 'key'>;
  onSaved(status: unknown): void;
  onCancel(): void;
}) {
  const t = useT();
  const [form, setForm] = useState<ApnsSet>({ ...initial, key: '' });
  const file = useRef<HTMLInputElement>(null);
  const set = (k: keyof ApnsSet) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));
  const save = useMutation({
    mutationFn: () => api.setApns(form),
    onSuccess: onSaved,
    onError: (e) => toast.error((e as Error).message),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate();
  };
  return (
    <form onSubmit={submit} className="space-y-3 px-4 py-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <Input
          value={form.teamId}
          onChange={set('teamId')}
          placeholder={t('apns.teamId')}
          aria-label={t('apns.teamId')}
          className="rounded-full"
          autoCapitalize="characters"
          spellCheck={false}
          required
        />
        <Input
          value={form.keyId}
          onChange={set('keyId')}
          placeholder={t('apns.keyId')}
          aria-label={t('apns.keyId')}
          className="rounded-full"
          autoCapitalize="characters"
          spellCheck={false}
          required
        />
        <Input
          value={form.bundleId}
          onChange={set('bundleId')}
          placeholder={t('apns.bundleId')}
          aria-label={t('apns.bundleId')}
          className="rounded-full"
          autoCapitalize="none"
          spellCheck={false}
          required
        />
      </div>
      <Textarea
        value={form.key}
        onChange={set('key')}
        placeholder={t('apns.keyPlaceholder')}
        aria-label={t('apns.keyFile')}
        className="min-h-28 rounded-2xl font-mono text-xs"
        spellCheck={false}
        required
      />
      <input
        ref={file}
        type="file"
        accept=".p8"
        className="hidden"
        onChange={async (e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (!f) return;
          const text = await f.text();
          setForm((s) => ({ ...s, key: text }));
        }}
      />
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="rounded-full"
          onClick={() => file.current?.click()}
        >
          <FileUp /> {t('apns.pickFile')}
        </Button>
        <div className="flex-1" />
        <Button type="button" variant="ghost" size="sm" className="rounded-full" onClick={onCancel}>
          {t('common.cancel')}
        </Button>
        <Button type="submit" size="sm" className="rounded-full" disabled={save.isPending}>
          {t('common.save')}
        </Button>
      </div>
    </form>
  );
}
