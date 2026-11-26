import type { OAuthAuth, OAuthCredential } from '@earendil-works/pi-ai';
import type { ProviderInfo, ProviderSignIn } from '@leafbot/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SubscriptionService } from '../src/services/subscriptions';
import { testServer, waitFor, type TestServer } from './helpers';

/** A plan's sign-in as the provider runs it, driven by the test. */
function fakeFlows() {
  const calls = { refresh: 0, deviceId: '' as string | undefined, agent: '' as string | undefined };
  let finish: (c: OAuthCredential) => void = () => {};
  const device: OAuthAuth = {
    name: 'Plan',
    async login(i, o) {
      calls.deviceId = o?.getDeviceId?.();
      calls.agent = o?.agentName;
      const domain = await i.prompt({ type: 'text', message: 'Enterprise?' });
      i.notify({
        type: 'device_code',
        userCode: 'ABCD-1234',
        verificationUri: `https://${domain || 'github.com'}/login/device`,
      });
      return new Promise<OAuthCredential>((r) => (finish = r));
    },
    async refresh(c) {
      calls.refresh++;
      return { ...c, access: `fresh-${calls.refresh}`, expires: Date.now() + 3_600_000 };
    },
    async toAuth(c) {
      return { apiKey: c.access, baseUrl: 'https://api.plan.example' };
    },
  };
  const browser: OAuthAuth = {
    name: 'Browser plan',
    async login(i) {
      i.notify({ type: 'auth_url', url: 'https://auth.example/authorize?x=1' });
      const pasted = await i.prompt({ type: 'manual_code', message: 'Paste' });
      const code = new URL(pasted).searchParams.get('code');
      return { type: 'oauth', access: `token-${code}`, refresh: 'r', expires: Date.now() + 3_600_000 };
    },
    refresh: async (c) => c,
    toAuth: async (c) => ({ apiKey: c.access }),
  };
  return {
    calls,
    flows: { 'github-copilot': device, openai: browser },
    finish: (c: OAuthCredential) => finish(c),
  };
}

describe('planla oturum açma', () => {
  let t: TestServer;
  let plans: SubscriptionService;
  let fake: ReturnType<typeof fakeFlows>;
  beforeEach(async () => {
    t = await testServer();
    fake = fakeFlows();
    plans = new SubscriptionService(t.services.ctx, t.services.vault, fake.flows);
  });
  afterEach(() => {
    plans.stop();
    return t.dispose();
  });

  it('cihaz koduyla açar, jetonu kilitli saklar, süresi dolunca yeniler', async () => {
    const started = await plans.start('github-copilot', { enterprise: '' });
    const waiting = await waitFor(async () => {
      const s = plans.status(started.id);
      return s.status === 'waiting' ? s : null;
    });
    expect(waiting).toMatchObject({ userCode: 'ABCD-1234', url: 'https://github.com/login/device' });
    expect(fake.calls.agent).toBe('Leaf Bot');
    expect(fake.calls.deviceId).toMatch(/^[0-9a-f-]{36}$/);

    fake.finish({
      type: 'oauth',
      access: 'a1',
      refresh: 'gh',
      expires: Date.now() - 1,
      availableModelIds: ['gpt-x'],
    });
    await waitFor(async () => plans.status(started.id).status === 'done');
    // Expired: the first use refreshes it, and the address of the plan comes with it.
    expect(await plans.auth('github-copilot')).toEqual({
      apiKey: 'fresh-1',
      baseUrl: 'https://api.plan.example',
    });
    expect(await plans.auth('github-copilot')).toEqual({
      apiKey: 'fresh-1',
      baseUrl: 'https://api.plan.example',
    });
    expect(fake.calls.refresh).toBe(1);
    expect([...(await plans.availableModels('github-copilot'))!]).toEqual(['gpt-x']);

    await plans.signOut('github-copilot');
    expect(await plans.auth('github-copilot')).toBeNull();
  });

  it('kendiliğinden dönemeyen oturumu yapıştırılan adresle bitirir', async () => {
    const started = await plans.start('openai');
    const waiting = await waitFor(async () => {
      const s = plans.status(started.id);
      return s.needsPaste ? s : null;
    });
    expect(waiting.url).toBe('https://auth.example/authorize?x=1');
    plans.paste(started.id, 'http://127.0.0.1:1455/auth/callback?code=xyz&state=s');
    await waitFor(async () => plans.status(started.id).status === 'done');
    expect(await plans.auth('openai')).toEqual({ apiKey: 'token-xyz' });
    expect(() => plans.paste(started.id, 'again')).toThrow();
  });

  it('bağlantı listesinde planla açılmış sağlayıcıyı ve Copilot’u gösterir; motor oturumun jetonunu kullanır', async () => {
    const list = (await t.api<ProviderInfo[]>('GET', '/api/providers')).body;
    expect(list.find((p) => p.id === 'github-copilot')).toMatchObject({
      configured: false,
      signIn: { signedIn: false },
    });
    expect(list.find((p) => p.id === 'openai')).toMatchObject({ signIn: { signedIn: false } });
    // Through the API: an unknown provider has no sign-in.
    expect((await t.api('POST', '/api/providers/nope/sign-in', {})).status).toBe(404);
    const s = (await t.api<ProviderSignIn>('POST', '/api/providers/github-copilot/sign-in', {})).body;
    expect(s.provider).toBe('github-copilot');
    expect((await t.api('DELETE', `/api/sign-ins/${s.id}`)).status).toBe(200);
    // A key comes before a sign-in for the same provider.
    expect(await t.services.keys.hasAuth('openai')).toBe(false);
    await t.api('PUT', '/api/providers/openai/key', { key: 'sk-test-123456789' });
    expect(await t.services.keys.hasAuth('openai')).toBe(true);
    expect(await t.services.keys.auth('openai')).toEqual({ apiKey: 'sk-test-123456789' });
  });
});
