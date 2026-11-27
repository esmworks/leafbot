import {
  describeSchedule,
  grokLinkPage,
  parseGrokLink,
  type BotImportPlan,
  type BotImportResult,
  type GrokChatResult,
} from '@leafbot/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArchiveRestore,
  ClipboardPaste,
  Copy,
  Download,
  ExternalLink,
  FileUp,
  FolderDown,
  Link2,
  Loader2,
  Plus,
} from 'lucide-react';
import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { useLocale, useT, type MessageKey } from '@/i18n';
import { api } from '@/lib/api';
import { copyText } from '@/lib/clipboard';
import { useFormat } from '@/lib/format';
import { useBots } from '@/lib/queries';
import { useUi } from '@/lib/store';
import { FoundProjects } from './FoundProjects';
import { GrokConnectCard } from './GrokConnectCard';
import { Card, Row } from './SettingsPage';

/** The instructions the other app follows to write the import file; served with the app. */
const EXPORT_INSTRUCTIONS = `${import.meta.env.BASE_URL}import/grok-bot-export.md`;

/** The text of the export, as a body the import route reads. */
const asBody = (text: string) => new Blob([text], { type: 'application/octet-stream' });

/**
 * Bots from Grok Bot: the person runs the export instructions there, then brings back what it
 * wrote: the file, its reply pasted as it came, a file it left in Downloads, or what it sent over
 * the connector link. Everything in it is shown before anything is saved; on the person's own
 * computer each bot's chat comes over too, from the Grok Bot app.
 */
export function ImportTab() {
  const t = useT();
  const locale = useLocale((s) => s.locale);
  const input = useRef<HTMLInputElement>(null);
  /** The export being previewed, and where it came from (a file's name), if anywhere. */
  const [text, setText] = useState<string | null>(null);
  const [source, setSource] = useState<string | null>(null);
  /** The last link arrival in the text being previewed, marked imported on the server after commit. */
  const [linkUpTo, setLinkUpTo] = useState<number | null>(null);
  const [reply, setReply] = useState('');
  const [plan, setPlan] = useState<BotImportPlan | null>(null);
  const [moved, setMoved] = useState<{ names: string[]; chats: GrokChatResult[] } | null>(null);
  const qc = useQueryClient();
  const look = useQuery({ queryKey: ['grok-look'], queryFn: api.grokLook, retry: false });
  const appBots = look.data?.appBots ?? null;

  const reset = () => {
    setText(null);
    setSource(null);
    setLinkUpTo(null);
    setPlan(null);
    if (input.current) input.current.value = '';
  };
  const preview = useMutation({
    mutationFn: (body: string) => api.previewBotImport(asBody(body)),
    onSuccess: setPlan,
    onError: (e) => {
      reset();
      toast.error((e as Error).message);
    },
  });
  const read = (body: string, from: string | null, upTo: number | null = null) => {
    setText(body);
    setSource(from);
    setLinkUpTo(upTo);
    setPlan(null);
    setMoved(null);
    preview.mutate(body);
  };
  const chats = useMutation({ mutationFn: api.grokChats });
  const commit = useMutation({
    mutationFn: (body: string) => api.importBots(asBody(body)),
    onSuccess: async (result: BotImportResult) => {
      toast.success(t('import.done', { count: result.botIds.length }));
      const names = result.plan.bots.map((b) => b.name);
      if (linkUpTo !== null) {
        void api
          .grokLinkImported(linkUpTo)
          .then((state) => qc.setQueryData(['grok-link'], state))
          .catch(() => {});
      }
      reset();
      setReply('');
      setMoved({ names, chats: [] });
      // Each bot's chat from the Grok Bot app, found by its name there, not the one it got here.
      if (appBots !== null && result.botIds.length) {
        const bots = result.botIds.map((id, i) => ({ id, name: result.plan.bots[i]!.nameInFile }));
        try {
          setMoved({ names, chats: await chats.mutateAsync(bots) });
        } catch (e) {
          toast.error((e as Error).message);
        }
      }
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const found = useMutation({
    mutationFn: (names: string[]) => api.grokFiles(names),
    onSuccess: (r, names) => read(r.text, names.join(', ')),
    onError: (e) => toast.error((e as Error).message),
  });
  const busy = preview.isPending || commit.isPending || found.isPending;

  // Loaded ahead so the click copies at once: a copy that waits on the network is no longer the
  // click's, and Safari refuses it.
  const instructions = useQuery({
    queryKey: ['import-instructions'],
    queryFn: async () => {
      const res = await fetch(EXPORT_INSTRUCTIONS);
      if (!res.ok) throw new Error(String(res.status));
      return res.text();
    },
    staleTime: Infinity,
  });
  /**
   * `scope`, when given, names the one bot to move and goes after the instructions; `intro`, when
   * given, is a note to the person who will run them and goes before.
   */
  const copyInstructions = async (scope?: string, intro?: string) => {
    const text = instructions.data ?? (await instructions.refetch()).data;
    const full =
      text && [intro && `${intro}\n\n---`, text, scope && `${scope}\n`].filter(Boolean).join('\n\n');
    if (full && (await copyText(full))) toast.success(t('import.copied'));
    else toast.error(t('import.copyFailed'));
  };

  return (
    <>
      <p className="mb-8 text-sm leading-relaxed text-muted-foreground">{t('import.hint')}</p>
      <GrokConnectCard
        disabled={busy}
        hosted={look.data?.onComputer === false}
        onArrived={(body, upTo) => read(body, t('import.fromLink'), upTo)}
      />
      {/* One card for the whole way by hand: the instructions out, then what Grok Bot wrote back in
          one of its three forms, in the order the person takes them. */}
      <Card title={t('import.move.title')} hint={t('import.move.hint')}>
        <Row label={t('import.instructions')} hint={t('import.instructionsHint')}>
          <Button
            variant="outline"
            size="sm"
            className="rounded-full"
            onClick={() => void copyInstructions()}
          >
            <Copy className="size-4" />
            {t('import.copy')}
          </Button>
          <Button variant="ghost" size="icon" className="size-8 rounded-full" asChild>
            <a href={EXPORT_INSTRUCTIONS} download="leafbot-export.md" aria-label={t('import.download')}>
              <Download className="size-4" />
            </a>
          </Button>
        </Row>
        <Row label={t('import.file')} hint={t('import.fileHint')}>
          <input
            ref={input}
            type="file"
            accept=".json,.md,.txt,application/json,text/plain"
            className="hidden"
            onChange={(e) => {
              const picked = e.target.files?.[0];
              if (picked) void picked.text().then((body) => read(body, picked.name));
            }}
          />
          <Button
            variant="outline"
            size="sm"
            className="rounded-full"
            disabled={busy}
            onClick={() => input.current?.click()}
          >
            {preview.isPending && source !== null ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <FileUp className="size-4" />
            )}
            {t('import.choose')}
          </Button>
        </Row>
        {look.data?.files.length ? (
          <Row
            label={t('import.found', { names: look.data.files.flatMap((f) => f.bots).join(', ') })}
            hint={look.data.files.map((f) => f.name).join(', ')}
          >
            <Button
              variant="outline"
              size="sm"
              className="rounded-full"
              disabled={busy}
              onClick={() => found.mutate(look.data!.files.map((f) => f.name))}
            >
              {found.isPending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <FolderDown className="size-4" />
              )}
              {t('import.useFound')}
            </Button>
          </Row>
        ) : null}
        <div className="space-y-3 px-4 py-3">
          <div>
            <div className="text-sm">{t('import.replyLabel')}</div>
            <div className="text-xs text-muted-foreground">{t('import.replyHint')}</div>
          </div>
          <Textarea
            value={reply}
            onChange={(e) => setReply(e.target.value)}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              const dropped = e.dataTransfer.files[0];
              if (!dropped) return;
              e.preventDefault();
              void dropped.text().then((body) => read(body, dropped.name));
            }}
            placeholder={t('import.replyPlaceholder')}
            aria-label={t('import.replyLabel')}
            className="max-h-48 min-h-24 rounded-xl text-sm"
          />
          <div className="flex justify-end">
            <Button
              variant="outline"
              size="sm"
              className="rounded-full"
              disabled={busy || !reply.trim()}
              onClick={() => read(reply, null)}
            >
              {preview.isPending && source === null ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <ClipboardPaste className="size-4" />
              )}
              {t('import.readReply')}
            </Button>
          </div>
        </div>
      </Card>

      <GrokLinkCard onCopy={(scope, intro) => void copyInstructions(scope, intro)} />

      {moved && <MovedCard names={moved.names} chats={moved.chats} loading={chats.isPending} />}

      {plan && text !== null && (
        <>
          <p className="mb-4 text-sm text-muted-foreground">{t('import.safety')}</p>
          {appBots !== null && <p className="mb-4 text-sm text-muted-foreground">{t('import.chatsToo')}</p>}
          {source && <p className="mb-4 text-xs text-muted-foreground">{t('import.from', { source })}</p>}
          <Card title={t('import.bots', { count: plan.bots.length })}>
            {plan.bots.map((bot) => (
              <details key={bot.ref} className="group px-4 py-3">
                <summary className="cursor-pointer list-none">
                  <div className="text-sm font-medium">{bot.name}</div>
                  <div className="text-xs text-muted-foreground">
                    {[
                      bot.description,
                      bot.name !== bot.nameInFile && t('import.renamed', { name: bot.nameInFile }),
                      bot.group && t('import.inGroup', { group: bot.group }),
                      t('import.counts', {
                        routines: bot.routines.length,
                        memories: bot.memories.length,
                        skills: bot.skills?.length ?? 0,
                      }),
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </div>
                </summary>
                <div className="mt-3 space-y-3 text-sm">
                  <section>
                    <h4 className="mb-1 text-xs font-medium text-muted-foreground">
                      {t('import.instructionsOf')}
                    </h4>
                    <pre className="max-h-64 overflow-y-auto rounded-xl bg-muted p-3 font-sans text-xs whitespace-pre-wrap">
                      {bot.instructions || t('import.none')}
                    </pre>
                  </section>
                  {bot.routines.length > 0 && (
                    <section>
                      <h4 className="mb-1 text-xs font-medium text-muted-foreground">
                        {t('import.routines')}
                      </h4>
                      <ul className="space-y-2">
                        {bot.routines.map((r, i) => (
                          <li key={i}>
                            <div className="text-xs font-medium">
                              {r.name} · {describeSchedule(r.schedule, locale)}
                            </div>
                            <div className="text-xs whitespace-pre-wrap text-muted-foreground">
                              {r.prompt}
                            </div>
                          </li>
                        ))}
                      </ul>
                    </section>
                  )}
                  {(bot.skills?.length ?? 0) > 0 && (
                    <section>
                      <h4 className="mb-1 text-xs font-medium text-muted-foreground">{t('import.skills')}</h4>
                      <ul className="space-y-1 text-xs">
                        {bot.skills.map((k) => (
                          <li key={k.name}>
                            <span className="font-medium">{k.name}</span>
                            {' · '}
                            {k.existing ? t('import.skillExists') : k.description}
                            {k.held && <div className="text-amber-600">{t('import.skillHeld')}</div>}
                            {k.body && (
                              <details className="mt-1">
                                <summary className="cursor-pointer text-muted-foreground">
                                  {t('import.skillBody')}
                                </summary>
                                <pre className="mt-1 max-h-64 overflow-y-auto rounded-xl bg-muted p-3 font-sans text-xs whitespace-pre-wrap">
                                  {k.body}
                                </pre>
                              </details>
                            )}
                          </li>
                        ))}
                      </ul>
                    </section>
                  )}
                  {bot.memories.length > 0 && (
                    <section>
                      <h4 className="mb-1 text-xs font-medium text-muted-foreground">
                        {t('import.memories')}
                      </h4>
                      <ul className="list-disc space-y-1 ps-5 text-xs">
                        {bot.memories.map((m, i) => (
                          <li key={i}>{m}</li>
                        ))}
                      </ul>
                    </section>
                  )}
                </div>
              </details>
            ))}
          </Card>
          {plan.groups.length > 0 && (
            <Card title={t('import.groups')}>
              {plan.groups.map((g) => (
                <Row
                  key={g.name}
                  label={g.name}
                  hint={g.members.map((ref) => plan.bots.find((b) => b.ref === ref)?.name ?? ref).join(', ')}
                />
              ))}
            </Card>
          )}
          {(plan.warnings.length > 0 || plan.notImported.length > 0) && (
            <Card title={t('import.leftOut')}>
              {plan.warnings.map((w, i) => (
                <Row key={`w${i}`} label={t(w.key as MessageKey, w.params)} />
              ))}
              {plan.notImported.map((n, i) => (
                <Row
                  key={`n${i}`}
                  label={n.what}
                  hint={[n.bot && (plan.bots.find((b) => b.ref === n.bot)?.name ?? n.bot), n.reason]
                    .filter(Boolean)
                    .join(' · ')}
                />
              ))}
            </Card>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" className="rounded-full" onClick={reset} disabled={commit.isPending}>
              {t('common.cancel')}
            </Button>
            <Button className="rounded-full" onClick={() => commit.mutate(text)} disabled={commit.isPending}>
              {commit.isPending && <Loader2 className="size-4 animate-spin" />}
              {t('import.confirm', { count: plan.bots.length })}
            </Button>
          </div>
        </>
      )}
      <FoundProjects />
      <ExportCard />
      <BackupCard />
    </>
  );
}

/** What the last import made, and for each bot whether its chat came over from the Grok Bot app. */
function MovedCard({
  names,
  chats,
  loading,
}: {
  names: string[];
  chats: GrokChatResult[];
  loading: boolean;
}) {
  const t = useT();
  return (
    <Card title={t('import.movedTitle')}>
      {names.map((name, i) => {
        const chat = chats[i];
        const hint = !chat
          ? loading
            ? t('import.chat.loading')
            : undefined
          : 'messages' in chat
            ? t('import.chat.came', { count: chat.messages })
            : t(`import.chat.${chat.reason}`);
        return <Row key={`${i}-${name}`} label={name} hint={hint} />;
      })}
      <Row label={t('import.movedRoutines')} />
    </Card>
  );
}

/** A heading between the rows of one card, for the ways that apply to one kind of person. */
const SUBHEAD = 'bg-muted/40 px-4 py-2 text-xs font-medium text-muted-foreground';

/**
 * A Grok Bot share or marketplace link. Its page shows the bot's name, who shared it and what it
 * does; the bot as a whole, with its instructions, memory, skills and routines, reaches the Grok
 * Bot app alone. So with a Grok Bot account the bot is added there first, then Grok Bot writes the
 * import file for that one bot, which is loaded below. Without one, the person who shared the bot
 * can write that file from their own Grok Bot, or a new bot starts here from what the page shows.
 */
function GrokLinkCard({ onCopy }: { onCopy: (scope: string, intro?: string) => void }) {
  const t = useT();
  const openSettings = useUi((s) => s.openSettings);
  const openBotPage = useUi((s) => s.openBotPage);
  const [link, setLink] = useState('');
  const read = useMutation({
    mutationFn: api.readGrokLink,
    onError: (e) => toast.error((e as Error).message),
  });
  const valid = parseGrokLink(link) !== null;
  // Only the answer for the link now in the field: one asked for an earlier link, or arriving
  // after the field changed, would name a different bot in the copied instructions.
  const card = read.data && read.variables === link.trim() ? read.data : null;
  const page = card && grokLinkPage(card.link);
  /**
   * The bot's name as the person's words to Grok Bot carry it. The sharer chose it, so the marks
   * that could close the quotes around it or start a new line are taken out.
   */
  const label = card?.name
    ?.replace(/[\p{C}"'`\u2018\u2019\u201C\u201D\u201E\u00AB\u00BB]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return (
    <Card title={t('import.link.title')} hint={t('import.link.hint')}>
      <form
        className="flex flex-wrap items-center gap-2 px-4 py-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) read.mutate(link.trim());
        }}
      >
        <Input
          value={link}
          onChange={(e) => setLink(e.target.value)}
          placeholder={t('import.link.placeholder')}
          aria-label={t('import.link.title')}
          className="min-w-0 flex-1 rounded-xl"
        />
        <Button type="submit" size="sm" className="rounded-full" disabled={!valid || read.isPending}>
          {read.isPending ? <Loader2 className="size-4 animate-spin" /> : <Link2 className="size-4" />}
          {t('import.link.read')}
        </Button>
      </form>
      {link.trim() && !valid && (
        <p className="px-4 pb-3 text-xs text-destructive">{t('import.link.invalid')}</p>
      )}
      {card && page && (
        <>
          <div className="px-4 py-3">
            <div className="text-sm font-medium">{card.name ?? t('import.link.unnamed')}</div>
            {card.sharer && (
              <div className="text-xs text-muted-foreground">
                {t('import.link.by', { name: card.sharer })}
              </div>
            )}
            {card.description && (
              <p className="mt-2 text-xs whitespace-pre-wrap text-muted-foreground">{card.description}</p>
            )}
            {!card.name && <p className="mt-2 text-xs text-muted-foreground">{t('import.link.unread')}</p>}
          </div>
          <div className={SUBHEAD}>{t('import.link.withAccount')}</div>
          <Row label={t('import.link.add')} hint={t('import.link.addHint')}>
            <Button variant="outline" size="sm" className="rounded-full" asChild>
              <a href={page} target="_blank" rel="noopener noreferrer">
                <ExternalLink className="size-4" />
                {t('import.link.open')}
              </a>
            </Button>
          </Row>
          <Row label={t('import.link.export')} hint={t('import.link.exportHint')}>
            <Button
              variant="outline"
              size="sm"
              className="rounded-full"
              onClick={() =>
                onCopy(
                  label
                    ? t('import.link.scope', { name: label, page })
                    : t('import.link.scopeUnnamed', { page }),
                )
              }
            >
              <Copy className="size-4" />
              {t('import.copy')}
            </Button>
          </Row>
          <Row label={t('import.link.load')} hint={t('import.link.loadHint')} />
          <div className={SUBHEAD}>{t('import.link.noAccount')}</div>
          <Row label={t('import.link.ask')} hint={t('import.link.askHint')}>
            <Button
              variant="outline"
              size="sm"
              className="rounded-full"
              onClick={() =>
                onCopy(
                  label
                    ? t('import.link.askScope', { name: label, page })
                    : t('import.link.askScopeUnnamed', { page }),
                  label ? t('import.link.askIntro', { name: label }) : t('import.link.askIntroUnnamed'),
                )
              }
            >
              <Copy className="size-4" />
              {t('import.copy')}
            </Button>
          </Row>
          {card.name && (
            <Row label={t('import.link.start')} hint={t('import.link.startHint')}>
              <Button
                variant="outline"
                size="sm"
                className="rounded-full"
                onClick={() => {
                  openSettings(null);
                  // The page's own words, shown in the form to read and change before saving.
                  openBotPage({
                    mode: 'create',
                    preset: {
                      name: card.name!,
                      description: card.description ?? '',
                      instructions: card.description ?? '',
                    },
                  });
                }}
              >
                <Plus className="size-4" />
                {t('import.link.startButton')}
              </Button>
            </Row>
          )}
        </>
      )}
    </Card>
  );
}

/** The smallest backup password the server takes. */
const MIN_PASSWORD = 12;

/**
 * Everything on the server in one file sealed with a password: to keep a copy, or to move to
 * another computer. Restoring replaces everything with what the file holds.
 */
function BackupCard() {
  const t = useT();
  const fmt = useFormat();
  const [password, setPassword] = useState('');
  const [restoreFile, setRestoreFile] = useState<File | null>(null);
  const [restorePassword, setRestorePassword] = useState('');
  const picker = useRef<HTMLInputElement>(null);
  const create = useMutation({
    mutationFn: () => api.createBackup(password),
    onSuccess: ({ id, size }) => {
      // A plain link, so a large file streams to disk instead of through the page.
      const a = document.createElement('a');
      a.href = `/api/backup/${id}`;
      a.download = '';
      document.body.append(a);
      a.click();
      a.remove();
      setPassword('');
      toast.success(t('backup.ready', { size: fmt.fileSize(size) }));
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const restore = useMutation({
    mutationFn: () => api.restoreBackup(restoreFile!, restorePassword),
    onSuccess: () => {
      toast.success(t('backup.restored'));
      // The server starts again with the restored data; the page follows once it is back.
      setTimeout(() => window.location.reload(), 4000);
    },
    onError: (e) => toast.error((e as Error).message),
  });
  return (
    <Card title={t('backup.title')} hint={t('backup.hint')}>
      <div className="flex flex-wrap items-center gap-2 px-4 py-3">
        <Input
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder={t('backup.passwordPlaceholder', { count: MIN_PASSWORD })}
          aria-label={t('backup.password')}
          className="min-w-0 flex-1 rounded-xl"
        />
        <Button
          size="sm"
          className="rounded-full"
          disabled={password.length < MIN_PASSWORD || create.isPending}
          onClick={() => create.mutate()}
        >
          {create.isPending ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />}
          {t('backup.download')}
        </Button>
      </div>
      <Row label={t('backup.restoreTitle')} hint={t('backup.restoreHint')}>
        <input
          ref={picker}
          type="file"
          accept=".ybk"
          className="hidden"
          onChange={(e) => setRestoreFile(e.target.files?.[0] ?? null)}
        />
        <Button variant="outline" size="sm" className="rounded-full" onClick={() => picker.current?.click()}>
          <FileUp className="size-4" />
          {restoreFile ? restoreFile.name : t('backup.pick')}
        </Button>
      </Row>
      {restoreFile && (
        <div className="flex flex-wrap items-center gap-2 px-4 py-3">
          <Input
            type="password"
            autoComplete="off"
            value={restorePassword}
            onChange={(e) => setRestorePassword(e.target.value)}
            placeholder={t('backup.password')}
            aria-label={t('backup.password')}
            className="min-w-0 flex-1 rounded-xl"
          />
          <Button
            size="sm"
            variant="destructive"
            className="rounded-full"
            disabled={!restorePassword || restore.isPending}
            onClick={() => {
              if (window.confirm(t('backup.restoreConfirm'))) restore.mutate();
            }}
          >
            {restore.isPending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <ArchiveRestore className="size-4" />
            )}
            {t('backup.restore')}
          </Button>
        </div>
      )}
    </Card>
  );
}

/** Bots written to an import file, to move them to another LeafBot or keep a copy. */
function ExportCard() {
  const t = useT();
  const { data: bots = [] } = useBots();
  const [off, setOff] = useState<Set<string>>(new Set());
  const picked = bots.filter((b) => !off.has(b.id));
  if (!bots.length) return null;
  const href = `/api/export/bots?ids=${picked.map((b) => b.id).join(',')}`;
  return (
    <Card title={t('export.title')} hint={t('export.hint')}>
      {bots.map((b) => (
        <Row key={b.id} label={b.name}>
          <Switch
            checked={!off.has(b.id)}
            onCheckedChange={(on) =>
              setOff((prev) => {
                const next = new Set(prev);
                if (on) next.delete(b.id);
                else next.add(b.id);
                return next;
              })
            }
            aria-label={b.name}
          />
        </Row>
      ))}
      <div className="flex justify-end px-4 py-3">
        {picked.length ? (
          <Button size="sm" className="rounded-full" asChild>
            <a href={href} download>
              <Download className="size-4" />
              {t('export.download', { count: picked.length })}
            </a>
          </Button>
        ) : (
          <Button size="sm" className="rounded-full" disabled>
            <Download className="size-4" />
            {t('export.download', { count: 0 })}
          </Button>
        )}
      </div>
    </Card>
  );
}
