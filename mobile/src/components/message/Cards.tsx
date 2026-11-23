import {
  type SubagentCard as SubagentCardProps,
  catalogEntry,
  connectionToolParts,
  describeAction,
  joinPicks,
  parseAnswers,
  splitPicks,
  questionItems,
  subagentTime,
  type Approval,
  type Bot,
  type OutsideTrigger,
} from '@leafbot/shared';
import Feather from '@expo/vector-icons/Feather';
import { isRefusal } from '@leafbot/app/src/lib/refusal';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { Avatar } from '@/components/Avatar';
import { Markdown } from '@/components/Markdown';
import { PillButton } from '@/components/page';
import { toastError } from '@/components/overlay';
import { locale, t } from '@/i18n';
import { nav } from '@/lib/nav';
import { useApprovals, useConnections, useMainThread, usePeople, useThread } from '@/lib/queries';
import { personNameOf } from '@/lib/today';
import { useApi, useServer } from '@/lib/server';
import { useColors } from '@/lib/theme';
import { bubblePalette, answeredText } from './util';

/** Answers a card; the cards list refreshes by itself when the server pushes the change. */
function useAnswer(id: string) {
  const api = useApi();
  const { origin } = useServer();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (d: Parameters<typeof api.answer>[1]) => api.answer(id, d),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['approvals', origin] }),
    onError: toastError,
  });
}

/** The name of the connection a tool belongs to (`mcp__<connection>__<tool>`), when it is one. */
function useServiceName(toolName: string | undefined): string | undefined {
  const { data: connections } = useConnections();
  const parts = toolName ? connectionToolParts(toolName) : null;
  return parts ? connections?.find((c) => c.slug === parts.server)?.name : undefined;
}

/** The one line an answered card leaves in the thread. */
function AnsweredLine({ text }: { text: string }) {
  const c = useColors();
  return <Text style={[styles.answered, { color: c.mutedForeground }]}>{text}</Text>;
}

/** What exactly the bot will run or touch, hidden until asked for. */
function Detail({ text }: { text: string }) {
  const c = useColors();
  const [open, setOpen] = useState(false);
  return (
    <View style={styles.gap8}>
      <Pressable onPress={() => setOpen((v) => !v)} hitSlop={6} accessibilityRole="button">
        <Text style={[styles.small, { color: c.mutedForeground }]}>
          {open ? t('approval.hide') : t('approval.show')}
        </Text>
      </Pressable>
      {open ? (
        <View style={[styles.detail, { backgroundColor: c.muted }]}>
          <Text style={[styles.small, { color: c.foreground }]} selectable>
            {text}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

export function ApprovalCard({
  approvalId,
  fallback,
  bots,
  heldBy,
  askRule,
  outside,
  noAlways,
  reviewReason,
  resembles,
  onAnswerLate,
}: {
  approvalId: string;
  fallback: string;
  bots: Map<string, Bot>;
  /** The "always ask" rule that stopped a bot otherwise allowed to go ahead. */
  heldBy?: string;
  /** The "always ask" rule that covers this request, for a bot that asks anyway. */
  askRule?: string;
  /** What outside text started the run: every change asks, and "always allow" is not offered. */
  outside?: OutsideTrigger;
  /** The card offers no "always allow": a guest's request, or a turn a stricter bot holds to its level. */
  noAlways?: boolean;
  /** Why the automatic review left this step to the person. */
  reviewReason?: string;
  /** The site the page address imitates: the card warns, and offers no "always allow". */
  resembles?: string;
  /** Answers a question that went unanswered, as a reply quoting it. */
  onAnswerLate?: () => void;
}) {
  const c = useColors();
  const { data: approvals } = useApprovals();
  const { data: people = [] } = usePeople();
  const a = approvals?.find((x) => x.id === approvalId);
  const service = useServiceName(a?.toolName);
  const decide = useAnswer(approvalId);
  if (!a) return <AnsweredLine text={fallback} />;
  const bot = bots.get(a.botId);
  const botName = bot?.name ?? t('common.bot');
  if (a.kind === 'question' && a.status !== 'denied' && a.status !== 'expired') {
    return <QuestionCard a={a} color={bot?.color ?? c.brand} />;
  }
  // A question nobody answered in time stays readable and can still be answered: the reply quotes
  // it and reaches the bot as an ordinary message.
  if (a.kind === 'question' && a.status === 'expired') {
    const { items } = questionItems(a);
    if (items.length && !items.some((q) => q.secret)) {
      return (
        <View style={[styles.card, styles.dashed, { borderColor: c.border }]}>
          {items.map((q, i) => (
            <Text key={i} style={[styles.body, { color: c.foreground }]}>
              {q.question}
            </Text>
          ))}
          <Text style={[styles.small, { color: c.mutedForeground }]}>
            {answeredText(a, botName, locale, service)}
          </Text>
          {onAnswerLate ? (
            <View style={styles.buttons}>
              <PillButton label={t('question.answerLate')} icon="corner-up-left" onPress={onAnswerLate} />
            </View>
          ) : null}
        </View>
      );
    }
  }
  if (a.kind === 'login' && a.status === 'pending') return <LoginCard a={a} />;
  if (a.status !== 'pending') return <AnsweredLine text={answeredText(a, botName, locale, service)} />;
  const action = describeAction(a.toolName, a.input, { bot: botName, locale, service });
  // A step that needs two people's yes, and has the first: it waits for the second.
  const waitingSecond = !!a.needsSecond && !!a.firstAt;
  return (
    <View style={[styles.card, { borderColor: `${c.amber}66`, backgroundColor: c.amberSoft }]}>
      <View style={styles.cardHead}>
        <Feather name="shield" size={24} color={c.amber} style={styles.headIcon} />
        <View style={styles.headText}>
          <Text style={[styles.body, styles.medium, { color: c.foreground }]}>{action.want}</Text>
          <Text style={[styles.body, { color: c.mutedForeground }]}>{t('approval.question')}</Text>
          {resembles ? (
            <Text style={[styles.small, styles.medium, { color: c.destructive }]}>
              {t('approval.resembles', { site: resembles })}
            </Text>
          ) : null}
          {heldBy ? (
            <Text style={[styles.small, { color: c.mutedForeground }]}>
              {t('approval.heldBy', { rule: heldBy })}
            </Text>
          ) : null}
          {reviewReason ? (
            <Text style={[styles.small, { color: c.mutedForeground }]}>
              {t('approval.reviewReason', { reason: reviewReason })}
            </Text>
          ) : null}
          {askRule ? (
            <Text style={[styles.small, { color: c.mutedForeground }]}>
              {t('approval.askRule', { rule: askRule })}
            </Text>
          ) : null}
          {outside ? (
            <Text style={[styles.small, { color: c.mutedForeground }]}>
              {t(`approval.outside.${outside}`)}
            </Text>
          ) : null}
          {a.needsSecond ? (
            <Text style={[styles.small, { color: c.mutedForeground }]}>
              {waitingSecond
                ? t('approval.waitingSecond', {
                    name: personNameOf(people, a.firstApprover, t('people.owner'), t('common.someone')),
                  })
                : t('approval.needsSecond')}
            </Text>
          ) : null}
          {action.detail ? <Detail text={action.detail} /> : null}
        </View>
      </View>
      <View style={styles.buttons}>
        {/* After the first yes the second must come from someone else: no button for it here. */}
        {waitingSecond ? null : (
          <PillButton
            label={t('approval.allowOnce')}
            icon="check"
            variant="primary"
            disabled={decide.isPending}
            onPress={() => decide.mutate({ decision: 'allow' })}
          />
        )}
        {/* An "always ask" rule outranks "always allow": offering it would change nothing. Nor is it
            taken from a run outside text started. */}
        {!heldBy && !askRule && !outside && !resembles && !noAlways && !a.needsSecond ? (
          <PillButton
            label={t('approval.allowAlways')}
            disabled={decide.isPending}
            onPress={() => decide.mutate({ decision: 'allow', remember: true })}
          />
        ) : null}
        <PillButton
          label={t('approval.deny')}
          icon="x"
          variant="ghost"
          disabled={decide.isPending}
          onPress={() => decide.mutate({ decision: 'deny' })}
        />
      </View>
    </View>
  );
}

/**
 * A bot asks to sign in to a site. What is typed here goes to the server, which types it into
 * that site; the bot never sees the password.
 */
function LoginCard({ a }: { a: Approval }) {
  const c = useColors();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [save, setSave] = useState(true);
  // The card names the whole site; the exact address it was asked on, when that differs.
  const host = typeof a.input.host === 'string' ? a.input.host : null;
  const [exact, setExact] = useState(false);
  const decide = useAnswer(a.id);
  const submit = () => {
    if (password) decide.mutate({ decision: 'allow', login: { username, password, save, exact } });
  };
  return (
    <View style={[styles.card, { borderColor: `${c.brand}4D`, backgroundColor: c.bubble }]}>
      <View style={styles.cardHead}>
        <Feather name="key" size={24} color={c.brand} style={styles.headIcon} />
        <View style={styles.headText}>
          <Text style={[styles.body, styles.medium, { color: c.foreground }]}>{a.summary}</Text>
          <Text style={[styles.small, { color: c.mutedForeground }]}>{t('signin.hint')}</Text>
        </View>
      </View>
      <TextInput
        value={username}
        onChangeText={setUsername}
        placeholder={t('signin.username')}
        placeholderTextColor={c.mutedForeground}
        accessibilityLabel={t('signin.username')}
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="username"
        textContentType="username"
        style={[styles.input, { color: c.foreground, backgroundColor: c.background, borderColor: c.border }]}
      />
      <TextInput
        value={password}
        onChangeText={setPassword}
        placeholder={t('signin.password')}
        placeholderTextColor={c.mutedForeground}
        accessibilityLabel={t('signin.password')}
        secureTextEntry
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="current-password"
        textContentType="password"
        onSubmitEditing={submit}
        style={[styles.input, { color: c.foreground, backgroundColor: c.background, borderColor: c.border }]}
      />
      <SwitchLine label={t('signin.save')} value={save} onChange={setSave} />
      {save && host ? (
        <SwitchLine label={t('signin.exactHost', { host })} value={exact} onChange={setExact} />
      ) : null}
      <View style={styles.buttons}>
        <PillButton
          label={t('signin.submit')}
          icon="check"
          variant="primary"
          disabled={decide.isPending || !password}
          onPress={submit}
        />
        <PillButton
          label={t('signin.cancel')}
          icon="x"
          variant="ghost"
          disabled={decide.isPending}
          onPress={() => decide.mutate({ decision: 'deny' })}
        />
      </View>
    </View>
  );
}

function SwitchLine({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  const c = useColors();
  return (
    <View style={styles.switchLine}>
      <Switch
        value={value}
        onValueChange={onChange}
        trackColor={{ true: c.primary, false: c.muted }}
        thumbColor={value ? c.primaryForeground : undefined}
        accessibilityLabel={label}
      />
      <Text style={[styles.small, styles.flex, { color: c.foreground }]}>{label}</Text>
    </View>
  );
}

/**
 * Questions from a bot, one page each. While open the options are buttons; once answered the
 * card stays, showing each question with the answer that was given.
 */
function QuestionCard({ a, color }: { a: Approval; color: string }) {
  const c = useColors();
  const { title, items } = questionItems(a);
  const answered = a.status === 'allowed';
  const [page, setPage] = useState(0);
  const [answers, setAnswers] = useState<string[]>(() =>
    answered ? parseAnswers(a.answer, items.length) : items.map(() => ''),
  );
  const [writing, setWriting] = useState(false);
  const [draft, setDraft] = useState('');
  const decide = useAnswer(a.id);
  const shown = answered ? parseAnswers(a.answer, items.length) : answers;
  const item = items[page]!;
  const many = items.length > 1;
  const last = page === items.length - 1;

  // On a question that takes several picks, the answer holds all of them (see `joinPicks`).
  const picks = item.multi ? splitPicks(shown[page] ?? '') : [];
  const toggle = (value: string) => {
    if (answered || decide.isPending) return;
    const next = picks.includes(value) ? picks.filter((p) => p !== value) : [...picks, value];
    setAnswers(answers.map((x, i) => (i === page ? joinPicks(next) : x)));
  };
  const choose = (value: string) => {
    if (answered || decide.isPending) return;
    if (item.multi) {
      // Words written beside the ticked options join them instead of replacing them.
      if (!picks.includes(value)) toggle(value);
      setWriting(false);
      setDraft('');
      return;
    }
    setAnswers(answers.map((x, i) => (i === page ? value : x)));
    setWriting(false);
    setDraft('');
    if (!many) decide.mutate({ decision: 'allow', answer: value });
    else if (!last) setPage(page + 1);
  };
  // A typed draft never follows to another page, so a secret one cannot show up in plain sight.
  const go = (to: number) => {
    setPage(to);
    setWriting(false);
    setDraft('');
  };
  const current = shown[page] ?? '';
  const optionIndex = item.options.indexOf(current);
  // A secret answer is never shown back, not even right after it is typed; only that one was given.
  const rows = item.secret
    ? answered || current
      ? [{ label: t('question.secretGiven'), index: -1 }]
      : []
    : item.multi
      ? [
          ...(answered ? [] : item.options).map((o, i) => ({ label: o, index: i })),
          // Picks written in the person's own words, shown as ticked rows that can be unticked.
          ...picks
            .filter((p) => !item.options.includes(p) || answered)
            .map((p) => ({ label: p, index: item.options.indexOf(p) })),
        ]
      : answered
        ? [{ label: current || t('question.empty'), index: optionIndex }]
        : item.options.map((o, i) => ({ label: o, index: i }));
  if (item.multi && answered && !rows.length) rows.push({ label: t('question.empty'), index: -1 });
  const palette = bubblePalette(c);

  return (
    <View style={styles.questionWrap}>
      {title ? (
        <View style={[styles.title, { backgroundColor: c.bubble }]}>
          <Text style={[styles.body, { color: c.foreground }]}>{title}</Text>
        </View>
      ) : null}
      <View
        style={[
          styles.card,
          { borderColor: answered ? c.border : `${c.amber}66` },
          !answered && { backgroundColor: c.amberSoft },
        ]}
      >
        <Markdown
          text={item.question}
          palette={answered ? { ...palette, text: c.mutedForeground } : palette}
        />
        {item.context ? (
          <Markdown text={item.context} palette={{ ...palette, text: c.mutedForeground }} />
        ) : null}
        <View style={styles.gap4}>
          {rows.map((r) => {
            const refusal = r.index >= 0 && isRefusal(r.label);
            const picked = item.multi
              ? !answered && picks.includes(r.label)
              : !answered && (item.secret || current === r.label);
            return (
              <Pressable
                key={r.label}
                accessibilityRole={item.multi && !answered ? 'checkbox' : 'button'}
                accessibilityState={item.multi && !answered ? { checked: picked } : undefined}
                disabled={answered || item.secret || decide.isPending}
                onPress={() => (item.multi ? toggle(r.label) : choose(r.label))}
                style={[styles.option, picked && { backgroundColor: c.accent }]}
              >
                {/* A choice that declines (No, Cancel) reads quieter than the ones that go ahead. */}
                <View style={[styles.badge, { backgroundColor: refusal ? c.muted : color }]}>
                  {item.multi && !answered && picked ? (
                    <Feather name="check" size={16} color="#FFFFFF" />
                  ) : r.index >= 0 ? (
                    <Text style={[styles.badgeText, { color: refusal ? c.mutedForeground : '#FFFFFF' }]}>
                      {String.fromCharCode(65 + r.index)}
                    </Text>
                  ) : (
                    <Feather name={item.secret ? 'key' : 'edit-2'} size={16} color="#FFFFFF" />
                  )}
                </View>
                <Text style={[styles.body, styles.flex, { color: c.foreground }]}>{r.label}</Text>
              </Pressable>
            );
          })}
          {!answered ? (
            item.secret || writing || item.options.length === 0 ? (
              <View style={styles.writeRow}>
                <TextInput
                  key={page}
                  autoFocus
                  value={draft}
                  onChangeText={setDraft}
                  secureTextEntry={item.secret}
                  autoCapitalize={item.secret ? 'none' : 'sentences'}
                  autoCorrect={!item.secret}
                  placeholder={t(item.secret ? 'question.secretPlaceholder' : 'question.placeholder')}
                  placeholderTextColor={c.mutedForeground}
                  returnKeyType="done"
                  onSubmitEditing={() => draft.trim() && choose(draft.trim())}
                  style={[styles.writeInput, { color: c.foreground, backgroundColor: c.muted }]}
                />
                <PillButton
                  label={t('question.ok')}
                  variant="primary"
                  disabled={!draft.trim() || decide.isPending}
                  onPress={() => choose(draft.trim())}
                />
              </View>
            ) : (
              <Pressable accessibilityRole="button" onPress={() => setWriting(true)} style={styles.option}>
                <View style={[styles.badge, { backgroundColor: c.muted }]}>
                  <Feather name="edit-2" size={16} color={c.foreground} />
                </View>
                <Text style={[styles.body, styles.flex, { color: c.mutedForeground }]}>
                  {t('question.other')}
                </Text>
              </Pressable>
            )
          ) : null}
        </View>
        {many || !answered ? (
          <View style={styles.footer}>
            {many ? (
              <View style={styles.dots}>
                {items.map((_, i) => (
                  <View
                    key={i}
                    style={[
                      styles.dot,
                      {
                        backgroundColor: i === page ? c.foreground : c.mutedForeground,
                        opacity: i === page ? 1 : 0.4,
                      },
                    ]}
                  />
                ))}
              </View>
            ) : null}
            <View style={styles.footerButtons}>
              {!answered ? (
                <PillButton
                  label={t('question.skip')}
                  variant="ghost"
                  disabled={decide.isPending}
                  onPress={() => decide.mutate({ decision: 'deny' })}
                />
              ) : null}
              {!many && item.multi && !answered ? (
                <PillButton
                  label={t('question.send')}
                  variant="primary"
                  disabled={!answers[0] || decide.isPending}
                  onPress={() => decide.mutate({ decision: 'allow', answer: answers[0] })}
                />
              ) : null}
              {many ? (
                <>
                  <PillButton label={t('question.back')} disabled={page === 0} onPress={() => go(page - 1)} />
                  {answered || !last ? (
                    <PillButton
                      label={t('question.next')}
                      disabled={last || (!answered && !answers[page])}
                      onPress={() => go(page + 1)}
                    />
                  ) : (
                    <PillButton
                      label={t('question.send')}
                      variant="primary"
                      disabled={answers.some((x) => !x) || decide.isPending}
                      onPress={() => decide.mutate({ decision: 'allow', answers })}
                    />
                  )}
                </>
              ) : null}
            </View>
          </View>
        ) : null}
      </View>
    </View>
  );
}

/** A small card with a logo, a title and a line under it, and what the person does on its right. */
function ServiceCard({
  name,
  title,
  detail,
  children,
}: {
  name: string;
  title: string;
  detail?: string;
  children: ReactNode;
}) {
  const c = useColors();
  return (
    <View style={[styles.service, { borderColor: c.border, backgroundColor: c.card }]}>
      <Avatar name={name} color={c.mutedForeground} size={36} />
      <View style={styles.flex}>
        <Text style={[styles.small, styles.medium, styles.sizeSm, { color: c.foreground }]}>{title}</Text>
        {detail ? (
          <Text style={[styles.small, { color: c.mutedForeground }]} numberOfLines={2}>
            {detail}
          </Text>
        ) : null}
      </View>
      {children}
    </View>
  );
}

function Connected() {
  const c = useColors();
  return (
    <View style={styles.connected}>
      <Feather name="check" size={16} color={c.success} />
      <Text style={[styles.small, { color: c.success }]}>{t('message.appConnected')}</Text>
    </View>
  );
}

/** A bot's suggestion to connect a service its task needs, with the button that does it. */
export function AppSuggestion({
  catalogId,
  reason,
  botId,
}: {
  catalogId: string;
  reason: string;
  botId?: string;
}) {
  const { data: connections = [] } = useConnections();
  const entry = catalogEntry(catalogId);
  if (!entry) return null;
  const connected = connections.some(
    (c) =>
      c.catalogId === catalogId &&
      c.status === 'connected' &&
      (!botId || c.allBots || c.botIds.includes(botId)),
  );
  return (
    <ServiceCard name={entry.name} title={t('message.appSuggestTitle', { app: entry.name })} detail={reason}>
      {connected ? (
        <Connected />
      ) : (
        <PillButton
          label={t('message.appConnect')}
          variant="primary"
          onPress={() => nav.apps({ botId, catalogId })}
        />
      )}
    </ServiceCard>
  );
}

/** A server a bot added that wants the person to sign in, with the button that opens it. */
export function SignInCard({
  connectionId,
  text,
  botId,
}: {
  connectionId: string;
  text: string;
  botId?: string;
}) {
  const { data: connections = [] } = useConnections();
  const conn = connections.find((x) => x.id === connectionId);
  if (!conn) return null;
  return (
    <ServiceCard name={conn.name} title={text} detail={conn.url}>
      {conn.status === 'connected' ? (
        <Connected />
      ) : (
        <PillButton
          label={t(conn.auth === 'token' ? 'message.enterKey' : 'message.signIn')}
          variant="primary"
          onPress={() => nav.apps({ botId, connectionId })}
        />
      )}
    </ServiceCard>
  );
}

export interface PlanItem {
  text: string;
  status: 'pending' | 'in_progress' | 'completed';
}

/** The bot's plan for its task, as it last wrote it: done steps ticked, the current one marked. */
export function PlanCard({ items }: { items: PlanItem[] }) {
  const c = useColors();
  const done = items.filter((i) => i.status === 'completed').length;
  return (
    <View
      accessibilityLabel={t('message.plan')}
      style={[styles.service, styles.plan, { borderColor: c.border, backgroundColor: c.card }]}
    >
      <View style={styles.planHead}>
        <Text style={[styles.small, styles.medium, { color: c.mutedForeground }]}>{t('message.plan')}</Text>
        <Text style={[styles.small, { color: c.mutedForeground }]}>
          {t('message.planProgress', { done, total: items.length })}
        </Text>
      </View>
      {items.map((item, i) => (
        <View
          key={i}
          style={styles.planItem}
          accessibilityLabel={`${item.text} (${t(`message.planStatus.${item.status}`)})`}
        >
          <Feather
            name={
              item.status === 'completed'
                ? 'check-circle'
                : item.status === 'in_progress'
                  ? 'loader'
                  : 'circle'
            }
            size={20}
            color={
              item.status === 'completed'
                ? c.success
                : item.status === 'in_progress'
                  ? c.brand
                  : c.mutedForeground
            }
            style={styles.planIcon}
          />
          <Text
            style={[
              styles.small,
              styles.sizeSm,
              styles.flex,
              { color: item.status === 'completed' ? c.mutedForeground : c.foreground },
              item.status === 'completed' && styles.strike,
              item.status === 'in_progress' && styles.medium,
            ]}
          >
            {item.text}
          </Text>
        </View>
      ))}
    </View>
  );
}

/** A helper the bot started for part of the work: what it was asked, how it stands, its steps. */
export function SubagentCard({ sub }: { sub: SubagentCardProps }) {
  const c = useColors();
  const [open, setOpen] = useState(false);
  // Its time is told once it has ended; while it runs, the spinner says so.
  const time = subagentTime(sub, t);
  return (
    <View
      accessibilityLabel={t('message.subagent')}
      style={[styles.service, styles.plan, { borderColor: c.border, backgroundColor: c.card }]}
    >
      <View style={styles.planHead}>
        <Text style={[styles.small, styles.medium, { color: c.mutedForeground }]}>
          {t('message.subagent')}
        </Text>
        <Text style={[styles.small, { color: c.mutedForeground }]}>
          {[t(`message.subagentState.${sub.state}`), t('message.subagentSteps', { count: sub.steps }), time]
            .filter(Boolean)
            .join(' · ')}
        </Text>
      </View>
      {sub.description ? (
        <View style={styles.planItem}>
          <Feather
            name={sub.state === 'running' ? 'loader' : sub.state === 'done' ? 'check-circle' : 'alert-circle'}
            size={20}
            color={sub.state === 'done' ? c.success : sub.state === 'running' ? c.brand : c.mutedForeground}
            style={styles.planIcon}
          />
          <Text style={[styles.small, styles.sizeSm, styles.flex, { color: c.foreground }]}>
            {sub.description}
          </Text>
        </View>
      ) : null}
      {sub.result && sub.state !== 'running' ? (
        <View>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded: open }}
            onPress={() => setOpen((o) => !o)}
            style={styles.planHead}
          >
            <Text style={[styles.small, { color: c.mutedForeground }]}>{t('message.subagentResult')}</Text>
            <Feather name={open ? 'chevron-up' : 'chevron-down'} size={16} color={c.mutedForeground} />
          </Pressable>
          {open ? (
            <Text selectable style={[styles.small, { color: c.foreground }]}>
              {sub.result}
            </Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

/** A conversation the bot opened, named in the thread with a button that goes there. */
export function OpenedThread({ threadId, text, room }: { threadId: string; text: string; room?: boolean }) {
  const c = useColors();
  const { data: thread } = useThread(threadId);
  const open = () => {
    if (!thread) return;
    // Inside a room the conversation opens on top; otherwise it takes this one's place.
    if (room) nav.chat(thread.botId, { threadId });
    else nav.replaceChat(thread.botId, { threadId });
  };
  return (
    <View style={styles.centerRow}>
      <Text style={[styles.note, { color: c.mutedForeground }]}>{text}</Text>
      <PillButton label={t('message.openThread')} disabled={!thread} onPress={open} />
    </View>
  );
}

/** Where a conversation the bot opened came from, with the way back to it. */
export function OpenedFrom({ threadId }: { threadId: string }) {
  const c = useColors();
  const { data: from } = useThread(threadId);
  const { data: main } = useMainThread(from?.botId ?? null);
  if (!from) return null;
  const isMain = from.id === main?.id;
  return (
    <Pressable
      accessibilityRole="button"
      onPress={() => nav.chat(from.botId, isMain ? {} : { threadId: from.id })}
      style={styles.openedFrom}
    >
      <Feather name="corner-up-left" size={16} color={c.mutedForeground} />
      <Text style={[styles.small, { color: c.mutedForeground }]} numberOfLines={1}>
        {t('message.openedFrom', { title: isMain || !from.title ? t('chat.mainThread') : from.title })}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  gap4: { gap: 4 },
  gap8: { gap: 8 },
  body: { fontSize: 17, lineHeight: 24 },
  small: { fontSize: 15, lineHeight: 21 },
  sizeSm: { fontSize: 16, lineHeight: 22 },
  medium: { fontWeight: '500' },
  strike: { textDecorationLine: 'line-through' },
  // Cards that ask something take the conversation's whole width.
  card: {
    alignSelf: 'stretch',
    gap: 12,
    borderRadius: 24,
    borderWidth: 1,
    paddingHorizontal: 20,
    paddingVertical: 16,
  },
  dashed: { borderStyle: 'dashed' },
  cardHead: { flexDirection: 'row', gap: 12 },
  headIcon: { marginTop: 2 },
  headText: { flex: 1, gap: 4 },
  buttons: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'center' },
  detail: { borderRadius: 12, paddingHorizontal: 12, paddingVertical: 8, maxHeight: 192 },
  answered: {
    alignSelf: 'flex-end',
    maxWidth: '92%',
    paddingHorizontal: 8,
    fontSize: 15,
    lineHeight: 21,
    textAlign: 'right',
  },
  input: {
    height: 44,
    borderRadius: 14,
    borderWidth: 1,
    paddingHorizontal: 14,
    fontSize: 17,
  },
  switchLine: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  questionWrap: { alignSelf: 'stretch', gap: 8 },
  title: { alignSelf: 'flex-start', borderRadius: 24, paddingHorizontal: 16, paddingVertical: 10 },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderRadius: 16,
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  badge: { width: 24, height: 24, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  badgeText: { fontSize: 13, fontWeight: '600' },
  writeRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingTop: 4 },
  writeInput: { flex: 1, height: 38, borderRadius: 19, paddingHorizontal: 16, fontSize: 16 },
  footer: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  dots: { flexDirection: 'row', gap: 6 },
  dot: { width: 6, height: 6, borderRadius: 3 },
  footerButtons: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginLeft: 'auto' },
  service: {
    alignSelf: 'flex-start',
    maxWidth: '92%',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderRadius: 16,
    borderWidth: 1,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  connected: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  plan: { flexDirection: 'column', alignItems: 'stretch', gap: 8, minWidth: 256 },
  planHead: { flexDirection: 'row', justifyContent: 'space-between', gap: 16 },
  planItem: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  planIcon: { marginTop: 2 },
  centerRow: { alignItems: 'center', gap: 8, paddingVertical: 4 },
  note: { fontSize: 16, lineHeight: 22, textAlign: 'center', paddingHorizontal: 24 },
  openedFrom: { flexDirection: 'row', alignItems: 'center', gap: 4 },
});
