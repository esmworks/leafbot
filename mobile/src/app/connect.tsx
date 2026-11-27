import { CameraView, useCameraPermissions } from 'expo-camera';
import { Redirect, router, useLocalSearchParams } from 'expo-router';
import { useRef, useState } from 'react';
import { Linking, StyleSheet, View } from 'react-native';
import { Button, ErrorText, Field, FormScreen, Hint, Mark, Title } from '@/components/ui';
import { t } from '@/i18n';
import { AccountError } from '@/lib/account';
import { parseConnectCode } from '@/lib/connectCode';
import { useServer } from '@/lib/server';
import { useColors } from '@/lib/theme';

/** What to tell the person when the account service did not take a code. */
function failure(err: unknown) {
  if (err instanceof AccountError) {
    if (err.status === 0 || err.status >= 500) return t('connect.accountDown');
    if (err.status === 429) return t('connect.tooMany');
  }
  return t('connect.codeRejected');
}

/**
 * Signs the phone in to the person's Leaf Bot account with a connect code, shown as a QR code by the
 * account's page (Settings, Connect your phone) or by `leafbot phone` on a server: scanned with the
 * camera, typed, or opened from the `leafbot://connect?code=…` link the QR code stands for. A code
 * works once, so one try runs at a time and a code that was tried is not tried again.
 */
export default function Connect() {
  const c = useColors();
  const { code: linked } = useLocalSearchParams<{ code?: string }>();
  const { ready, phase, redeem } = useServer();
  const [permission, askPermission] = useCameraPermissions();
  const link = typeof linked === 'string' ? linked : null;
  // A link only fills the code in: it is redeemed when the person says so, or a page or message
  // could sign this phone in to someone else's account without them knowing.
  const linkCode = link ? parseConnectCode(link) : null;
  const [scanning, setScanning] = useState(false);
  const [typing, setTyping] = useState(!!linkCode);
  const [value, setValue] = useState(linkCode ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [denied, setDenied] = useState(false);
  const running = useRef(false);
  const tried = useRef(new Set<string>());

  const attempt = async (raw: string) => {
    const code = parseConnectCode(raw);
    if (!code) return setError(t('connect.invalidCode'));
    // The scanner reports the same picture many times a second, and a code is spent by the first.
    if (running.current || tried.current.has(code)) return;
    running.current = true;
    tried.current.add(code);
    setBusy(true);
    setError(null);
    setScanning(false);
    try {
      await redeem(code);
      router.replace('/');
    } catch (err) {
      setError(failure(err));
      // A code the service did not reach is worth another try; a refused one is spent or wrong.
      if (err instanceof AccountError && err.status === 0) tried.current.delete(code);
    } finally {
      running.current = false;
      setBusy(false);
    }
  };

  const scan = async () => {
    setError(null);
    setDenied(false);
    if (!permission?.granted) {
      const asked = permission?.canAskAgain === false ? permission : await askPermission();
      if (!asked.granted) return setDenied(true);
    }
    setScanning(true);
  };

  if (ready && phase !== 'signedOut' && !link && !busy) return <Redirect href="/" />;

  if (scanning) {
    return (
      <FormScreen>
        <Title>{t('connect.scan')}</Title>
        <Hint>{t('connect.scanHint')}</Hint>
        <View style={[styles.camera, { borderColor: c.border }]}>
          <CameraView
            style={StyleSheet.absoluteFill}
            facing="back"
            barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
            onBarcodeScanned={({ data }) => void attempt(data)}
          />
        </View>
        <Button label={t('common.cancel')} variant="ghost" onPress={() => setScanning(false)} />
      </FormScreen>
    );
  }

  return (
    <FormScreen>
      <Mark />
      <Title>{t('connect.title')}</Title>
      <Hint>{t('connect.intro')}</Hint>
      {phase !== 'signedOut' ? <Hint>{t('connect.switchAccount')}</Hint> : null}
      {typing ? (
        <>
          <Field
            value={value}
            onChangeText={(v) => {
              setValue(v);
              setError(null);
            }}
            placeholder={t('connect.codePlaceholder')}
            accessibilityLabel={t('connect.code')}
            autoCapitalize="characters"
            autoCorrect={false}
            autoFocus
            returnKeyType="go"
            invalid={!!error}
            onSubmitEditing={() => void attempt(value)}
          />
          {error ? <ErrorText>{error}</ErrorText> : null}
          <Button label={t('connect.submit')} busy={busy} onPress={() => void attempt(value)} />
          <Button label={t('connect.scan')} variant="ghost" onPress={() => void scan()} />
        </>
      ) : (
        <>
          {error ? <ErrorText>{error}</ErrorText> : null}
          <Button label={t('connect.scan')} busy={busy} onPress={() => void scan()} />
          <Button label={t('connect.typeCode')} variant="ghost" onPress={() => setTyping(true)} />
        </>
      )}
      {denied ? (
        <>
          <ErrorText>{t('connect.cameraDenied')}</ErrorText>
          <Button
            label={t('connect.openSettings')}
            variant="ghost"
            onPress={() => void Linking.openSettings()}
          />
        </>
      ) : null}
    </FormScreen>
  );
}

const styles = StyleSheet.create({
  camera: {
    aspectRatio: 1,
    width: '100%',
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
});
