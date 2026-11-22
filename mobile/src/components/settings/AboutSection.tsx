import Feather from '@expo/vector-icons/Feather';
import { Image } from 'expo-image';
import { useUpdates } from 'expo-updates';
import * as WebBrowser from 'expo-web-browser';
import { Platform, StyleSheet, Text, View } from 'react-native';
import { toast } from '@/components/overlay';
import { Row, Section } from '@/components/page';
import { Pad, Rows } from './common/controls';
import { locale, t } from '@/i18n';
import { formatters } from '@/lib/format';
import { useInfo } from '@/lib/queries';
import { useColors } from '@/lib/theme';
import { checkForUpdate, restartIntoUpdate, updatesOn } from '@/lib/updates';
// The app's own icon, the same picture the web app shows here.
import LOGO from '../../../assets/logo.png';

/**
 * Copyright, license and source notices required by the AGPL. The NOTICE file's additional terms
 * oblige anyone who conveys or hosts a modified version to keep the product attribution and the
 * repository link visible here.
 */
const REPO_URL = 'https://github.com/esmworks/leafbot';

/** A new issue with the version and the device filled in, so a report starts with what it needs. */
function issueUrl(version: string | undefined): string {
  const body = [
    `Version: ${version ?? '?'}`,
    `Device: ${Platform.OS} ${String(Platform.Version)}`,
    '',
    '',
  ].join('\n');
  return `${REPO_URL}/issues/new?body=${encodeURIComponent(body)}`;
}

const fmt = formatters(locale, t);

/**
 * Which build of the app's code is running, and a way to take a new one now rather than wait for
 * the next start. A copy that takes no updates says so instead of offering a button that cannot work.
 */
function UpdatesSection() {
  const { currentlyRunning, isChecking, isDownloading, isUpdatePending } = useUpdates();
  if (!updatesOn) {
    return (
      <Section title={t('update.title')}>
        <Row label={t('update.running')} detail={t('update.off')} value={t('update.builtIn')} />
      </Section>
    );
  }
  const running =
    currentlyRunning.isEmbeddedLaunch || !currentlyRunning.createdAt
      ? t('update.builtIn')
      : t('update.from', { day: fmt.dayLabel(currentlyRunning.createdAt.toISOString()) });
  const check = () =>
    void checkForUpdate().then(
      (found) => !found && toast(t('update.none')),
      (e: unknown) =>
        toast(t('update.failed', { error: e instanceof Error ? e.message : String(e) }), { tone: 'error' }),
    );
  return (
    <Section title={t('update.title')} footer={t('update.hint')}>
      <Rows>
        <Row label={t('update.running')} value={running} />
        {isUpdatePending ? (
          <Row
            icon="refresh-cw"
            label={t('update.restart')}
            detail={t('update.restartHint')}
            onPress={restartIntoUpdate}
          />
        ) : (
          <Row
            icon="download"
            label={t('update.check')}
            onPress={check}
            busy={isChecking || isDownloading}
            disabled={isChecking || isDownloading}
          />
        )}
      </Rows>
    </Section>
  );
}

/** The "about" settings section's content, under the section's own title bar. */
export function AboutSection() {
  const c = useColors();
  const { data: info } = useInfo();
  const link = (href: string, label: string, hint = href.replace('https://', '')) => (
    <Row
      label={label}
      detail={hint}
      chevron={false}
      onPress={() => void WebBrowser.openBrowserAsync(href)}
      right={<Feather name="external-link" size={22} color={c.mutedForeground} />}
    />
  );
  return (
    <>
      <View style={styles.head}>
        <Image source={LOGO} style={styles.logo} accessible={false} />
        <View style={styles.headText}>
          <Text style={[styles.name, { color: c.foreground }]}>{t('about.name')}</Text>
          <Text style={[styles.version, { color: c.mutedForeground }]}>
            {t('about.version', { version: info?.version ?? '…' })}
          </Text>
        </View>
      </View>
      <UpdatesSection />
      <Section title={t('about.license')}>
        <Pad gap={8}>
          <Text style={[styles.text, { color: c.foreground }]}>{t('about.copyright')}</Text>
          <Text style={[styles.text, { color: c.mutedForeground }]}>{t('about.licenseText')}</Text>
          <Text style={[styles.text, { color: c.mutedForeground }]}>{t('about.warranty')}</Text>
        </Pad>
      </Section>
      <Section title={t('about.links')}>
        <Rows>
          {link(REPO_URL, t('about.source'))}
          {link(`${REPO_URL}/blob/main/LICENSE`, t('about.licenseLink'))}
          {link(`${REPO_URL}/blob/main/NOTICE`, t('about.notice'))}
          {link(issueUrl(info?.version), t('about.report'), t('about.reportHint'))}
        </Rows>
      </Section>
    </>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', gap: 16, paddingHorizontal: 16 },
  logo: { width: 56, height: 56, borderRadius: 14 },
  headText: { flex: 1, gap: 2 },
  name: { fontSize: 20, fontWeight: '600' },
  version: { fontSize: 16 },
  text: { fontSize: 16, lineHeight: 22 },
});
