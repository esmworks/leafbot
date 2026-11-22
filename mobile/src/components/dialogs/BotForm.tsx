import {
  EFFORTS,
  PERMISSION_MODES,
  shownMode,
  type ShownMode,
  selectorLines,
  ToolSelection,
  type Bot,
  type Effort,
} from '@leafbot/shared';
import { availableStarters, starterBot, type StarterId } from '@leafbot/app/src/features/onboarding/profile';
import Feather from '@expo/vector-icons/Feather';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Avatar } from '@/components/Avatar';
import { AreaBox, FormField, SaveButton, TextBox } from '@/components/dialogs/common';
import { COLORS, newBotEngine } from '@/components/dialogs/model';
import { confirm, toast, toastError } from '@/components/overlay';
import { Empty, Loading, Note, Page, Row, Section, SwitchRow, back } from '@/components/page';
import { ChipRow, ChoiceRow, Pad, Rows } from '@/components/settings/common/controls';
import { ModelDefaults } from '@/components/settings/connect/ModelDefaults';
import { PiModelPicker } from '@/components/settings/connect/ProviderConnect';
import { TelegramSection } from '@/components/settings/TelegramSection';
import { t, type MessageKey } from '@/i18n';
import { avatarFor, objectsFor, SAFE_AVATAR } from '@/lib/avatars';
import { nav } from '@/lib/nav';
import { useBots, useGroups, useInfo, useProviders, useSettings } from '@/lib/queries';
import { useApi, useServer } from '@/lib/server';
import { useColors } from '@/lib/theme';

const NO_GROUP = '';
/** Tool names as cards name them; examples, the same in every language. */
const TOOLS_EXAMPLE = 'Read\nmcp__leafbot__memory_*\nmcp__gmail__search_threads';
const TOOLS_EXCLUDE_EXAMPLE = 'Bash\nmcp__leafbot__browser_*';
/** The message for tool lines the server would refuse, or nothing. */
const toolsError = (text: string): MessageKey | undefined =>
  ToolSelection.shape.allow.safeParse(selectorLines(text)).success ? undefined : 'bot.toolsInvalid';
/** The effort row's value for "as set for all bots"; efforts never take this form. */
const DEFAULT_EFFORT = '*';

const MODE_LABEL: Record<(typeof PERMISSION_MODES)[number], MessageKey> = {
  readonly: 'mode.readonly',
  ask: 'mode.ask',
  auto: 'mode.auto',
};

interface Form {
  name: string;
  description: string;
  instructions: string;
  groupId: string;
  newGroup: string;
  color: string;
  avatar: string;
  permissionMode: ShownMode;
  isManager: boolean;
  memory: boolean;
  effort: Effort | '';
  toolsOnly: boolean;
  /** Tool names, one per line, as approval cards name them. */
  toolsAllow: string;
  toolsExclude: string;
  internet: boolean;
  projectDir: string;
  engine: 'claude' | 'pi';
  /** The model for Claude; `provider/model` for the other engine. */
  model: string;
}

function initial(bot: Bot | undefined, start: { engine: 'claude' | 'pi'; model: string }): Form {
  return {
    name: bot?.name ?? '',
    description: bot?.description ?? '',
    instructions: bot?.instructions ?? '',
    groupId: bot?.groupId ?? NO_GROUP,
    newGroup: '',
    color: bot?.color ?? COLORS[0]!,
    // The old shape name is what every server takes: a current one stores it as the round object.
    avatar: bot?.avatar ?? SAFE_AVATAR,
    permissionMode: bot ? shownMode(bot.permissionMode) : 'auto',
    isManager: bot?.isManager ?? false,
    memory: bot?.memory ?? true,
    effort: (bot?.effort as Effort | '' | undefined) ?? '',
    toolsOnly: bot?.toolSelection.only ?? false,
    toolsAllow: bot?.toolSelection.allow.join('\n') ?? '',
    toolsExclude: bot?.toolSelection.exclude.join('\n') ?? '',
    internet: bot?.internet ?? true,
    projectDir: bot?.projectDir ?? '',
    engine: bot?.engine ?? start.engine,
    model: bot?.model ?? start.model,
  };
}

/** Creates a bot, or edits the one named by `botId`. */
export function BotEditor({ botId }: { botId?: string }) {
  const bots = useBots();
  const settings = useSettings();
  if (bots.isLoading || (!botId && settings.isLoading)) {
    return (
      <Page title={t('bot.new')}>
        <Loading />
      </Page>
    );
  }
  const bot = botId ? bots.data?.find((b) => b.id === botId) : undefined;
  if (botId && !bot) {
    return (
      <Page title={t('bot.new')}>
        <Empty icon="alert-circle" text={t('dialogs.botNotFound')} />
      </Page>
    );
  }
  return <BotFormPage key={bot?.id ?? 'new'} bot={bot} />;
}

function BotFormPage({ bot }: { bot?: Bot }) {
  const c = useColors();
  const api = useApi();
  const { origin } = useServer();
  const qc = useQueryClient();
  const { data: groups = [] } = useGroups();
  const { data: bots = [] } = useBots();
  const { data: settings } = useSettings();
  const { data: info } = useInfo();
  const { data: providers = [] } = useProviders();
  const start = useMemo(() => initial(bot, newBotEngine(settings)), [bot, settings]);
  const [v, setV] = useState<Form>(start);
  const [tried, setTried] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const dirty = JSON.stringify(v) !== JSON.stringify(start);
  const set = <K extends keyof Form>(k: K, val: Form[K]) => setV((f) => ({ ...f, [k]: val }));
  const pi = v.engine === 'pi';

  // Offered once, when the page opens: a bot made meanwhile does not reshuffle the choices.
  const [starters] = useState(() =>
    bot
      ? []
      : availableStarters(
          t,
          bots.map((b) => b.name),
        ),
  );
  const starterOn = (id: StarterId) => {
    const s = starterBot(id, t);
    return (
      v.name === s.name &&
      v.description === s.description &&
      v.instructions === s.instructions &&
      v.avatar === s.avatar &&
      v.color === s.color
    );
  };
  /** Fills the form from a starter; choosing the chosen one again empties it. */
  const pickStarter = (id: StarterId) => {
    const fill = starterOn(id) ? initial(undefined, newBotEngine(settings)) : starterBot(id, t);
    setV((f) => ({
      ...f,
      name: fill.name,
      description: fill.description,
      instructions: fill.instructions,
      avatar: fill.avatar,
      color: fill.color,
    }));
  };

  const nameError: MessageKey | undefined = v.name.trim() ? undefined : 'bot.nameRequired';
  const modelError: MessageKey | undefined =
    pi && !/^[^/]+\/.+/.test(v.model.trim()) ? 'bot.modelRequired' : undefined;
  const keyMissing = pi && providers.length > 0 && !providers.some((p) => p.configured);
  // Only a definite "not signed in"; an unchecked or failing connection is not worth a warning here.
  const claudeLoggedOut = !pi && info?.claude.status === 'logged-out';

  const save = useMutation({
    mutationFn: async () => {
      let groupId: string | null = v.groupId === NO_GROUP ? null : v.groupId;
      if (v.newGroup.trim()) groupId = (await api.createGroup(v.newGroup.trim())).id;
      const body = {
        name: v.name.trim(),
        description: v.description,
        instructions: v.instructions,
        groupId,
        color: v.color,
        // A newly chosen object the server would not know (a starter's, on an older server) goes as
        // the round shape; a bot's own avatar goes back as it came.
        avatar: v.avatar === start.avatar ? v.avatar : avatarFor(v.avatar, info?.version),
        permissionMode: v.permissionMode,
        isManager: v.isManager,
        memory: v.memory,
        effort: v.effort,
        toolSelection: {
          only: v.toolsOnly,
          allow: selectorLines(v.toolsAllow),
          exclude: selectorLines(v.toolsExclude),
        },
        internet: v.internet,
        projectDir: v.projectDir.trim() || null,
        engine: v.engine,
        model: v.model.trim(),
      };
      return bot ? api.updateBot(bot.id, body) : api.createBot(body);
    },
    onSuccess: (saved) => {
      // Put the bot in the cache first so the chat opened next does not fall back to another bot.
      qc.setQueryData<Bot[]>(['bots', origin], (old = []) => [
        ...old.filter((b) => b.id !== saved.id),
        saved,
      ]);
      void qc.invalidateQueries({ queryKey: ['bots', origin] });
      void qc.invalidateQueries({ queryKey: ['groups', origin] });
      if (bot) back();
      else nav.replaceChat(saved.id);
    },
    onError: toastError,
  });
  const archive = useMutation({
    mutationFn: () => api.archiveBot(bot!.id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['bots', origin] });
      toast(t('bot.archived'));
      nav.list();
    },
    onError: toastError,
  });

  const submit = () => {
    setTried(true);
    if (nameError || modelError) return;
    save.mutate();
  };
  const leave = async () => {
    if (
      dirty &&
      !(await confirm({
        title: t('bot.discardConfirm'),
        confirmLabel: t('dialogs.discard'),
        destructive: true,
      }))
    )
      return;
    back();
  };

  // The objects this server takes; an old shape shows as the circle it is drawn as.
  const objects = objectsFor(info?.version);
  const chosenObject = v.avatar.startsWith('object:')
    ? v.avatar.slice('object:'.length)
    : v.avatar.startsWith('shape:')
      ? 'circle'
      : null;

  const efforts: { value: string; label: string }[] = [
    { value: DEFAULT_EFFORT, label: t(pi ? 'bot.effortModelDefault' : 'bot.effortDefault') },
    ...EFFORTS.map((e) => ({ value: e, label: t(`effort.${e}`) })),
  ];

  return (
    <Page
      title={bot ? t('bot.settingsTitle', { name: bot.name }) : t('bot.new')}
      onBack={() => void leave()}
      right={
        <SaveButton label={bot ? t('common.save') : t('bot.create')} onPress={submit} busy={save.isPending} />
      }
    >
      {starters.length > 0 ? (
        <Section title={t('bot.starters')}>
          <Pad>
            <ChipRow>
              {starters.map((id) => {
                const s = starterBot(id, t);
                const on = starterOn(id);
                return (
                  <Pressable
                    key={id}
                    accessibilityRole="button"
                    accessibilityState={{ selected: on }}
                    onPress={() => pickStarter(id)}
                    style={({ pressed }) => [
                      styles.starter,
                      {
                        borderColor: on ? c.brand : c.border,
                        backgroundColor: on ? `${c.brand}1A` : 'transparent',
                      },
                      pressed && { opacity: 0.7 },
                    ]}
                  >
                    <Avatar name={s.name} color={s.color} avatar={s.avatar} size={24} />
                    <Text style={[styles.starterText, { color: c.foreground }]}>{s.name}</Text>
                  </Pressable>
                );
              })}
            </ChipRow>
          </Pad>
        </Section>
      ) : null}

      <Section>
        <Pad gap={16}>
          <View style={styles.preview}>
            <Avatar name={v.name || t('common.bot')} color={v.color} avatar={v.avatar} size={72} />
          </View>
          <View style={styles.swatches}>
            {COLORS.map((col) => (
              <Pressable
                key={col}
                accessibilityRole="button"
                accessibilityLabel={col}
                accessibilityState={{ selected: col === v.color }}
                onPress={() => set('color', col)}
                style={[styles.color, { backgroundColor: col }]}
              >
                {col === v.color ? <Feather name="check" size={20} color="#FFFFFF" /> : null}
              </Pressable>
            ))}
          </View>
          {objects.length > 0 ? (
            <View style={styles.objects} accessibilityLabel={t('bot.object')}>
              {objects.map((o) => {
                const on = o === chosenObject;
                return (
                  <Pressable
                    key={o}
                    accessibilityRole="button"
                    accessibilityLabel={t(`bot.object.${o}` as MessageKey)}
                    accessibilityState={{ selected: on }}
                    onPress={() => set('avatar', `object:${o}`)}
                    style={({ pressed }) => [
                      styles.object,
                      { borderColor: on ? c.brand : 'transparent' },
                      pressed && { opacity: 0.7 },
                    ]}
                  >
                    <Avatar name="" color={v.color} avatar={`object:${o}`} size={36} />
                  </Pressable>
                );
              })}
            </View>
          ) : null}
        </Pad>
      </Section>

      <FormField label={t('bot.name')} error={tried ? nameError : undefined}>
        <TextBox
          value={v.name}
          onChangeText={(x) => set('name', x)}
          maxLength={60}
          autoFocus={!bot}
          placeholder={t('bot.namePlaceholder')}
          invalid={tried && !!nameError}
        />
      </FormField>

      <FormField label={t('bot.group')}>
        <Section>
          <ChoiceRow
            label={t('bot.group')}
            value={v.groupId}
            options={[
              { value: NO_GROUP, label: t('bot.noGroup') },
              ...groups.map((g) => ({ value: g.id, label: g.name })),
            ]}
            onChange={(g) => set('groupId', g)}
          />
        </Section>
        <TextBox
          value={v.newGroup}
          onChangeText={(x) => set('newGroup', x)}
          maxLength={60}
          placeholder={t('bot.newGroup')}
        />
      </FormField>

      <FormField label={t('bot.description')}>
        <TextBox
          value={v.description}
          onChangeText={(x) => set('description', x)}
          maxLength={500}
          placeholder={t('bot.descriptionPlaceholder')}
        />
      </FormField>

      <FormField label={t('bot.instructions')}>
        <AreaBox
          value={v.instructions}
          onChangeText={(x) => set('instructions', x)}
          maxLength={20_000}
          placeholder={t('bot.instructionsPlaceholder')}
        />
      </FormField>

      <Section>
        <Rows>
          <ChoiceRow
            label={t('bot.engine')}
            detail={t(pi ? 'bot.engineHint.pi' : 'bot.engineHint.claude')}
            value={v.engine}
            options={[
              { value: 'claude', label: t('bot.engine.claude') },
              { value: 'pi', label: t('bot.engine.pi') },
            ]}
            onChange={(e) => setV((f) => ({ ...f, engine: e, model: '', effort: '' }))}
          />
          <Pad gap={16}>
            <Text style={[styles.sectionLabel, { color: c.foreground }]}>{t('bot.model')}</Text>
            {pi ? (
              <PiModelPicker value={v.model} onChange={(m) => set('model', m)} />
            ) : (
              <ModelDefaults
                value={{ model: v.model, effort: v.effort }}
                onChange={(m) => setV((f) => ({ ...f, model: m.model, effort: m.effort }))}
              />
            )}
            {tried && modelError ? <Note tone="error">{t(modelError)}</Note> : null}
            {keyMissing ? <Note>{t('bot.keyMissing')}</Note> : null}
            {claudeLoggedOut ? <Note>{t('bot.claudeLoggedOut')}</Note> : null}
          </Pad>
          {pi ? (
            <ChoiceRow
              label={t('model.effort')}
              value={v.effort || DEFAULT_EFFORT}
              options={efforts}
              onChange={(e) => set('effort', e === DEFAULT_EFFORT ? '' : (e as Effort))}
            />
          ) : null}
        </Rows>
      </Section>

      <Section>
        <Row
          label={t('bot.advanced')}
          detail={t('bot.advancedHint')}
          onPress={() => setAdvanced((a) => !a)}
          chevron={false}
          right={
            <Feather name={advanced ? 'chevron-up' : 'chevron-down'} size={22} color={c.mutedForeground} />
          }
        />
        {advanced ? (
          <Rows>
            <ChoiceRow
              label={t('bot.permissionMode')}
              detail={t(`bot.modeHint.${v.permissionMode}`)}
              value={v.permissionMode}
              options={PERMISSION_MODES.map((m) => ({ value: m, label: t(MODE_LABEL[m]) }))}
              onChange={(m) => set('permissionMode', m)}
            />
            <Pad>
              <FormField label={t('bot.projectDir')} hint={t('bot.projectDirHint')}>
                <TextBox
                  value={v.projectDir}
                  onChangeText={(x) => set('projectDir', x)}
                  maxLength={1000}
                  autoCapitalize="none"
                  autoCorrect={false}
                  placeholder={t('bot.projectDirPlaceholder')}
                />
              </FormField>
            </Pad>
            <SwitchRow
              label={t('bot.internet')}
              detail={t('bot.internetHint')}
              value={v.internet}
              onChange={(on) => set('internet', on)}
            />
            <SwitchRow
              label={t('bot.manager')}
              detail={t('bot.managerHint')}
              value={v.isManager}
              onChange={(on) => set('isManager', on)}
            />
            <SwitchRow
              label={t('bot.memory')}
              detail={t('bot.memoryHint')}
              value={v.memory}
              onChange={(on) => set('memory', on)}
            />
            <SwitchRow
              label={t('bot.toolsOnly')}
              detail={t('bot.toolsHint')}
              value={v.toolsOnly}
              onChange={(on) => set('toolsOnly', on)}
            />
          </Rows>
        ) : null}
      </Section>
      {advanced ? (
        <>
          {v.toolsOnly ? (
            <FormField label={t('bot.toolsAllow')} error={toolsError(v.toolsAllow)}>
              <AreaBox
                value={v.toolsAllow}
                onChangeText={(x) => set('toolsAllow', x)}
                autoCapitalize="none"
                autoCorrect={false}
                spellCheck={false}
                placeholder={TOOLS_EXAMPLE}
              />
            </FormField>
          ) : null}
          <FormField label={t('bot.toolsExclude')} error={toolsError(v.toolsExclude)}>
            <AreaBox
              value={v.toolsExclude}
              onChangeText={(x) => set('toolsExclude', x)}
              autoCapitalize="none"
              autoCorrect={false}
              spellCheck={false}
              placeholder={TOOLS_EXCLUDE_EXAMPLE}
            />
          </FormField>
        </>
      ) : null}

      {bot ? <TelegramSection botId={bot.id} /> : null}

      {bot ? (
        <Section>
          <Row
            icon="archive"
            label={t('bot.archive')}
            onPress={() => archive.mutate()}
            busy={archive.isPending}
            chevron={false}
          />
        </Section>
      ) : null}
    </Page>
  );
}

const styles = StyleSheet.create({
  starter: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderWidth: 1,
    borderRadius: 18,
    paddingLeft: 6,
    paddingRight: 12,
    height: 36,
  },
  starterText: { fontSize: 16 },
  preview: { alignItems: 'center' },
  swatches: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, justifyContent: 'center' },
  color: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  objects: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, justifyContent: 'center' },
  object: { padding: 4, borderRadius: 12, borderWidth: 2 },
  sectionLabel: { fontSize: 17, fontWeight: '500' },
});
