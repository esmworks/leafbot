import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AccountError } from './account';
import { BrowserSignIn, readSession, writeSession, type SessionFile } from './sign-in';

const crypt: SessionFile = {
  encrypt: (text) => Buffer.from(`enc:${text}`),
  decrypt: (data) => {
    const s = data.toString();
    if (!s.startsWith('enc:')) throw new Error('bad');
    return s.slice(4);
  },
};

function setUp(redeem: (code: string, verifier: string) => Promise<{ token: string }>) {
  const opened: string[] = [];
  const kept: string[] = [];
  const signIn = new BrowserSignIn({
    account: {
      redeem: async (code, verifier) => ({
        user: { id: 'u', email: 'e' },
        sessionId: 's',
        ...(await redeem(code, verifier)),
      }),
    },
    openBrowser: async (url) => void opened.push(url),
    locale: () => 'tr',
    signedIn: (token) => void kept.push(token),
  });
  return { signIn, opened, kept };
}

describe('tarayıcıda giriş', () => {
  it('tarayıcıyı challenge ile açar, dönen kodu aynı girişin doğrulayıcısıyla harcar', async () => {
    let used: { code: string; verifier: string } | null = null;
    const { signIn, opened, kept } = setUp(async (code, verifier) => {
      used = { code, verifier };
      return { token: 'tok' };
    });
    const done = signIn.start();
    expect(opened[0]).toMatch(/^https:\/\/www\.leafbot\.app\/tr\/connect\?challenge=[A-Za-z0-9_-]{43}$/);
    expect(await signIn.finish('leafbot://connect?code=ABCDEFGHJK')).toEqual({ ok: true });
    expect(await done).toEqual({ ok: true });
    expect(kept).toEqual(['tok']);
    expect(used!.code).toBe('ABCDE-FGHJK');
    expect(used!.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(signIn.pending).toBe(false);
  });

  it('bekleyen giriş yoksa gelen kodu harcamaz', async () => {
    let calls = 0;
    const { signIn, kept } = setUp(async () => {
      calls++;
      return { token: 'tok' };
    });
    expect(await signIn.finish('leafbot://connect?code=ABCDEFGHJK')).toBeNull();
    expect(calls).toBe(0);
    expect(kept).toEqual([]);
  });

  it('ikinci giriş ilkinin yerini alır', async () => {
    const { signIn } = setUp(async () => ({ token: 'tok' }));
    const first = signIn.start();
    const second = signIn.start();
    expect(await first).toEqual({ ok: false, reason: 'replaced' });
    signIn.cancel();
    expect(await second).toEqual({ ok: false, reason: 'replaced' });
  });

  it('reddedilen ve ulaşılamayan kodu ayırır', async () => {
    const refused = setUp(async () => {
      throw new AccountError(400, 'invalid_code');
    });
    const a = refused.signIn.start();
    await refused.signIn.finish('leafbot://connect?code=ABCDEFGHJK');
    expect(await a).toEqual({ ok: false, reason: 'rejected' });

    const down = setUp(async () => {
      throw new AccountError(0, 'unreachable');
    });
    const b = down.signIn.start();
    await down.signIn.finish('leafbot://connect?code=ABCDEFGHJK');
    expect(await b).toEqual({ ok: false, reason: 'unreachable' });
  });
});

describe('oturum dosyası', () => {
  it('şifreli ve yalnızca kullanıcının okuyacağı biçimde saklanır, silinir', () => {
    const dir = mkdtempSync(join(tmpdir(), 'leafbot-session-'));
    expect(readSession(dir, crypt)).toBeNull();
    writeSession(dir, crypt, 'tok');
    expect(readFileSync(join(dir, 'account-session'), 'utf8')).toBe('enc:tok');
    expect(statSync(join(dir, 'account-session')).mode & 0o777).toBe(0o600);
    expect(readSession(dir, crypt)).toBe('tok');
    writeSession(dir, crypt, null);
    expect(readSession(dir, crypt)).toBeNull();
  });

  it('çözülemeyen dosyayı oturum saymaz', () => {
    const dir = mkdtempSync(join(tmpdir(), 'leafbot-session-'));
    writeSession(dir, { ...crypt, encrypt: (t) => Buffer.from(t) }, 'plain');
    expect(readSession(dir, crypt)).toBeNull();
  });
});
