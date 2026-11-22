import { createHmac } from 'node:crypto';
import { appEventFilter, type Routine, type RoutineRun } from '@leafbot/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { schema } from '../src/db';
import { testServer, type TestServer } from './helpers';

describe('uygulama olaylarıyla çalışan rutin', () => {
  let t: TestServer;
  beforeEach(async () => {
    t = await testServer();
  });
  afterEach(async () => {
    await t.dispose();
  });

  const setUp = async (filter: string) => {
    const bot = await t.bot();
    const r = (
      await t.api<Routine>('POST', '/api/routines', {
        botId: bot.id,
        name: 'Ödeme takibi',
        prompt: 'Olayı özetle.',
        schedule: { type: 'daily', time: '09:00' },
      })
    ).body;
    const hooked = (await t.api<Routine>('POST', `/api/routines/${r.id}/webhook`)).body;
    await t.api('PATCH', `/api/routines/${r.id}`, { webhookFilter: filter });
    return { r, token: hooked.webhookToken! };
  };
  const runs = async (id: string) => (await t.api<RoutineRun[]>('GET', `/api/routines/${id}/runs`)).body;
  const post = (r: Routine, token: string, raw: string, headers: Record<string, string>) =>
    t.app.inject({
      method: 'POST',
      url: `/api/hooks/routines/${r.id}/${token}`,
      headers: { host: 'localhost', 'content-type': 'application/json', ...headers },
      payload: raw,
    });
  const stripeSig = (secret: string, raw: string, at = Math.floor(Date.now() / 1000)) =>
    `t=${at},v1=${createHmac('sha256', secret).update(`${at}.${raw}`).digest('hex')}`;

  it('Stripe anahtarı girilince yalnız onunla imzalı çağrı rutini başlatır', async () => {
    const { r, token } = await setUp(appEventFilter('stripe', 'paymentFailed')!);
    const secret = 'whsec_test_1234567890';
    const saved = await t.api<Routine>('PUT', `/api/routines/${r.id}/webhook-secret`, { secret });
    expect(saved.status).toBe(200);
    expect(saved.body.webhookSecretSet).toBe(true);
    expect(JSON.stringify(saved.body)).not.toContain(secret);

    const raw = JSON.stringify({ id: 'evt_1', type: 'payment_intent.payment_failed' });
    expect((await post(r, token, raw, {})).statusCode).toBe(401);
    // The routine's own secret is in its address, so signing with it no longer starts the routine.
    const github = `sha256=${createHmac('sha256', token).update(raw).digest('hex')}`;
    expect((await post(r, token, raw, { 'x-hub-signature-256': github })).statusCode).toBe(401);
    expect((await post(r, token, raw, { 'x-gitlab-token': token })).statusCode).toBe(401);
    expect(
      (await post(r, token, raw, { 'stripe-signature': stripeSig('whsec_baska', raw) })).statusCode,
    ).toBe(401);
    const old = stripeSig(secret, raw, Math.floor(Date.now() / 1000) - 3600);
    expect((await post(r, token, raw, { 'stripe-signature': old })).statusCode).toBe(401);

    const other = JSON.stringify({ id: 'evt_2', type: 'charge.succeeded' });
    expect(
      (await post(r, token, other, { 'stripe-signature': stripeSig(secret, other) })).json(),
    ).toMatchObject({
      status: 'filtered',
    });
    const ok = await post(r, token, raw, { 'stripe-signature': stripeSig(secret, raw) });
    expect(ok.statusCode).toBe(202);
    await t.services.turns.idle();
    expect(await runs(r.id)).toHaveLength(1);
  });

  it('Shopify olayın türünü başlıktan okur; anahtar silinince adres yine yeter', async () => {
    const { r, token } = await setUp(appEventFilter('shopify', 'orderCreated')!);
    const secret = 'shpss_test_secret';
    await t.api('PUT', `/api/routines/${r.id}/webhook-secret`, { secret });
    const raw = JSON.stringify({ id: 1, total_price: '10.00' });
    const sign = (s: string) => createHmac('sha256', s).update(raw).digest('base64');
    const paid = await post(r, token, raw, {
      'x-shopify-topic': 'orders/paid',
      'x-shopify-hmac-sha256': sign(secret),
    });
    expect(paid.json()).toMatchObject({ status: 'filtered' });
    const created = await post(r, token, raw, {
      'x-shopify-topic': 'orders/create',
      'x-shopify-hmac-sha256': sign(secret),
    });
    expect(created.statusCode).toBe(202);

    const cleared = await t.api<Routine>('PUT', `/api/routines/${r.id}/webhook-secret`, { secret: null });
    expect(cleared.body.webhookSecretSet).toBe(false);
    const unsigned = await post(r, token, raw, { 'x-shopify-topic': 'orders/create' });
    expect(unsigned.statusCode).toBe(202);
    await t.services.turns.idle();
  });

  it('webhook kapatılınca uygulamanın anahtarı da silinir', async () => {
    const { r } = await setUp(appEventFilter('linear', 'issueCreated')!);
    await t.api('PUT', `/api/routines/${r.id}/webhook-secret`, { secret: 'lin_wh_secret_123' });
    // Kept sealed with the vault key, so a copy of the database does not reveal it.
    const [row] = await t.services.ctx.db.select().from(schema.routines).where(eq(schema.routines.id, r.id));
    expect(row!.webhookSecret).toMatch(/^v2:/);
    expect(row!.webhookSecret).not.toContain('lin_wh_secret_123');
    const off = await t.api<Routine>('DELETE', `/api/routines/${r.id}/webhook`);
    expect(off.body.webhookSecretSet).toBe(false);
    // Without an address there is nothing for the app to sign.
    const none = await t.api('PUT', `/api/routines/${r.id}/webhook-secret`, { secret: 'lin_wh_secret_123' });
    expect(none.status).toBe(400);
    expect((await t.api('PUT', `/api/routines/${r.id}/webhook-secret`, { secret: 'kısa' })).status).toBe(400);
  });
});
