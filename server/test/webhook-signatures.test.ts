import { createHmac } from 'node:crypto';
import { appEventFilter, appEventOf, APP_EVENT_SOURCES, appMakesSecret, passesFilter } from '@leafbot/shared';
import { describe, expect, it } from 'vitest';
import { checkSignature, eventHeader, signatureAllows } from '../src/services/webhook-signatures';

const raw = Buffer.from('{"type":"payment_intent.succeeded","action":"create"}');
const mac = (key: string, data: Buffer | string) => createHmac('sha256', key).update(data);
const headers = (h: Record<string, string>) => (name: string) => h[name];
const keys = { token: 'rutin-sirri', secret: 'whsec_uygulama' };

describe('uygulama webhook imzaları', () => {
  it('kişinin yazdığı sırla imzalayan uygulamaları rutinin sırrıyla doğrular', () => {
    const now = 1_800_000_000_000;
    const t = String(now / 1000);
    const cases: Record<string, string>[] = [
      { 'x-hub-signature-256': `sha256=${mac(keys.token, raw).digest('hex')}` },
      { 'x-gitlab-token': keys.token },
      { 'typeform-signature': `sha256=${mac(keys.token, raw).digest('base64')}` },
      {
        'calendly-webhook-signature': `t=${t},v1=${mac(keys.token, `${t}.${raw.toString()}`).digest('hex')}`,
      },
    ];
    for (const h of cases) {
      expect(checkSignature(headers(h), raw, keys, now).valid).toBe(true);
      // The same call with another body, or with another secret, is turned away.
      expect(checkSignature(headers(h), Buffer.from('{}'), keys, now).valid).toBe(
        'x-gitlab-token' in h ? true : false,
      );
      expect(checkSignature(headers(h), raw, { ...keys, token: 'baska' }, now).valid).toBe(false);
    }
  });

  it('kendi sırrını yapan uygulamaları yapıştırılan sırla doğrular; sır yoksa denetlenmemiş sayar', () => {
    const now = 1_800_000_000_000;
    const t = String(now / 1000);
    const cases: Record<string, string>[] = [
      {
        'stripe-signature': `t=${t},v1=deadbeef,v1=${mac(keys.secret, `${t}.${raw.toString()}`).digest('hex')}`,
      },
      { 'x-shopify-hmac-sha256': mac(keys.secret, raw).digest('base64') },
      { 'linear-signature': mac(keys.secret, raw).digest('hex') },
      { 'sentry-hook-signature': mac(keys.secret, raw).digest('hex') },
    ];
    for (const h of cases) {
      expect(checkSignature(headers(h), raw, keys, now)).toMatchObject({ valid: true });
      expect(checkSignature(headers(h), raw, { ...keys, secret: 'yanlis' }, now).valid).toBe(false);
      expect(checkSignature(headers(h), raw, { ...keys, secret: null }, now).valid).toBeNull();
    }
  });

  it('eski tarihli imzayı yeniden gönderilmiş sayar', () => {
    const now = 1_800_000_000_000;
    const t = String(now / 1000 - 600);
    const h = { 'stripe-signature': `t=${t},v1=${mac(keys.secret, `${t}.${raw.toString()}`).digest('hex')}` };
    expect(checkSignature(headers(h), raw, keys, now).valid).toBe(false);
  });

  it('sır verilmiş rutin imzasız ya da denetlenemeyen çağrıyı geri çevirir', () => {
    expect(signatureAllows({ scheme: null, keyed: null, valid: null }, false)).toBe(true);
    expect(signatureAllows({ scheme: null, keyed: null, valid: null }, true)).toBe(false);
    expect(signatureAllows({ scheme: 'stripe', keyed: 'secret', valid: null }, false)).toBe(true);
    expect(signatureAllows({ scheme: 'stripe', keyed: 'secret', valid: true }, true)).toBe(true);
    expect(signatureAllows({ scheme: 'github', keyed: 'token', valid: false }, false)).toBe(false);
    // The routine's own secret is part of its address, so it does not stand in for the app's.
    expect(signatureAllows({ scheme: 'github', keyed: 'token', valid: true }, true)).toBe(false);
    expect(signatureAllows({ scheme: 'gitlab', keyed: 'token', valid: true }, true)).toBe(false);
  });

  it('olay türünü uygulamanın başlığından okur', () => {
    expect(eventHeader(headers({ 'x-shopify-topic': 'orders/create' }))).toBe('orders/create');
    expect(eventHeader(headers({ 'sentry-hook-resource': 'issue' }))).toBe('issue');
    expect(eventHeader(headers({}))).toBeUndefined();
  });
});

describe('uygulama olayları kataloğu', () => {
  it('her olayın süzgeci kendi örnek çağrısını geçirir, başkasınınkini geçirmez', () => {
    const body = (o: unknown) => JSON.stringify(o);
    const stripe = appEventFilter('stripe', 'paymentSucceeded')!;
    expect(passesFilter(stripe, body({ type: 'payment_intent.succeeded' }))).toBe(true);
    expect(passesFilter(stripe, body({ type: 'payment_intent.payment_failed' }))).toBe(false);
    const merged = appEventFilter('github', 'prMerged')!;
    expect(
      passesFilter(merged, body({ event: 'pull_request', action: 'closed', pull_request: { merged: true } })),
    ).toBe(true);
    expect(
      passesFilter(
        merged,
        body({ event: 'pull_request', action: 'closed', pull_request: { merged: false } }),
      ),
    ).toBe(false);
    const order = appEventFilter('shopify', 'orderCreated')!;
    expect(passesFilter(order, body({ event: 'orders/create', id: 1 }))).toBe(true);
  });

  it('süzgecin hangi olaydan yazıldığını, kişi değiştirene kadar tanır', () => {
    for (const s of APP_EVENT_SOURCES)
      for (const e of s.events)
        expect(appEventOf(appEventFilter(s.app, e.id)!)).toEqual({ app: s.app, event: e.id });
    const f = appEventFilter('linear', 'issueCreated')!;
    expect(appEventOf(`${f}\ntitle~=acil`)).toBeNull();
    expect(appEventOf('action=opened')).toBeNull();
    expect(appEventFilter('yok', 'x')).toBeNull();
    expect(appMakesSecret('stripe')).toBe(true);
    expect(appMakesSecret('github')).toBe(false);
  });
});
