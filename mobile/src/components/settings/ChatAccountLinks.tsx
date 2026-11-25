import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as Clipboard from 'expo-clipboard';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { toast, toastError } from '@/components/overlay';
import { PillButton, Section } from '@/components/page';
import { Hint, Pad, Rows } from '@/components/settings/common/controls';
import { t, type MessageKey } from '@/i18n';
import { useApi, useServer } from '@/lib/server';
import { useColors } from '@/lib/theme';

type Link = {
  available: boolean;
  linked: { name: string } | null;
  code?: string | null;
  workspace?: string | null;
};

/** The words each app's card says, as the web's own cards say them. */
const WORDS = {
  slack: {
    title: 'slack.mine',
    linkedAs: 'slack.linkedAs',
    notLinked: 'slack.notLinked',
    how: 'slack.howItWorks',
    send: 'slack.sendCode',
    copied: 'slack.codeCopied',
  },
  teams: {
    title: 'teams.mine',
    linkedAs: 'teams.linkedAs',
    notLinked: 'teams.notLinked',
    how: null,
    send: 'teams.sendCode',
    copied: 'teams.copied',
  },
} as const satisfies Record<string, Record<string, MessageKey | null>>;

/**
 * The person's own Slack and Teams accounts linked to their account here, so the bots know who
 * writes to them there. Each shows only when the server has that app set up.
 */
export function ChatAccountLinks() {
  return (
    <>
      <AccountLink app="slack" />
      <AccountLink app="teams" />
    </>
  );
}

function AccountLink({ app }: { app: 'slack' | 'teams' }) {
  const c = useColors();
  const api = useApi();
  const qc = useQueryClient();
  const { origin } = useServer();
  const key = [`${app}-link`, origin];
  const { data: link } = useQuery<Link>({
    queryKey: key,
    queryFn: app === 'slack' ? api.slackLink : api.teamsLink,
  });
  const put = (l: Link) => qc.setQueryData(key, l);
  const code = useMutation({
    mutationFn: (): Promise<Link> => (app === 'slack' ? api.slackCode() : api.teamsCode()),
    onSuccess: put,
    onError: toastError,
  });
  const unlink = useMutation({
    mutationFn: (): Promise<Link> => (app === 'slack' ? api.slackUnlink() : api.teamsUnlink()),
    onSuccess: put,
    onError: toastError,
  });
  if (!link?.available) return null;
  const w = WORDS[app];
  const command = link.code ? `link ${link.code}` : '';
  return (
    <Section title={t(w.title)}>
      <Rows>
        <Pad>
          <Text style={[styles.text, { color: link.linked ? c.foreground : c.mutedForeground }]}>
            {link.linked
              ? t(w.linkedAs, { name: link.linked.name })
              : t(w.notLinked, { workspace: link.workspace ?? '' })}
          </Text>
          {w.how ? <Hint>{t(w.how)}</Hint> : null}
          {command ? (
            <Pressable
              accessibilityRole="button"
              onPress={() =>
                void Clipboard.setStringAsync(command).then(
                  () => toast(t(w.copied)),
                  () => toast(t('message.copyFailed'), { tone: 'error' }),
                )
              }
              style={[styles.code, { backgroundColor: c.muted }]}
            >
              <Text style={[styles.text, { color: c.foreground }]}>{t(w.send)}</Text>
              <Text selectable style={[styles.command, { color: c.foreground }]}>
                {command}
              </Text>
            </Pressable>
          ) : null}
          <View style={styles.buttons}>
            {link.linked ? (
              <PillButton
                label={t('slack.unlink')}
                variant="ghost"
                busy={unlink.isPending}
                onPress={() => unlink.mutate()}
              />
            ) : (
              <PillButton
                label={t(command ? 'slack.newCode' : 'slack.getCode')}
                busy={code.isPending}
                onPress={() => code.mutate()}
              />
            )}
          </View>
        </Pad>
      </Rows>
    </Section>
  );
}

const styles = StyleSheet.create({
  text: { fontSize: 16, lineHeight: 22 },
  code: { borderRadius: 14, padding: 14, gap: 4 },
  command: { fontSize: 20, fontWeight: '600', fontFamily: 'Menlo' },
  buttons: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, justifyContent: 'flex-end' },
});
