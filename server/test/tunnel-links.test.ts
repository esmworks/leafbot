import type { TicketClaims } from '@leafbot/shared/account';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AccountLinks } from '../src/tunnel/links';
import { OWNER_ID } from '../src/users';
import { testServer, type TestServer } from './helpers';

const claims = (sub: string, role: TicketClaims['role']): TicketClaims => ({
  iss: 'https://accounts.example',
  aud: 'host_12345678',
  sub,
  kind: 'client',
  sid: 'sess_12345678',
  jti: 'jti_12345678',
  iat: 0,
  exp: 60,
  ...(role && { role }),
  mid: 'mem_12345678',
  epoch: 0,
});

describe('AccountLinks', () => {
  let t: TestServer;
  let links: AccountLinks;
  beforeAll(async () => {
    t = await testServer();
    links = new AccountLinks(t.services.ctx.db);
  });
  afterAll(async () => {
    await t.dispose();
  });

  it('links the owning account to the owner, and no second one', async () => {
    expect(await links.resolve(claims('acct_owner001', 'owner'))).toEqual({ userId: OWNER_ID });
    expect(await links.resolve(claims('acct_owner001', 'owner'))).toEqual({ userId: OWNER_ID });
    expect(await links.resolve(claims('acct_owner002', 'owner'))).toBeNull();
  });

  it('makes a person for a member on the first visit and keeps the role in step', async () => {
    const first = await links.resolve(claims('acct_member01', 'member'));
    expect(first).not.toBeNull();
    expect((await t.auth.users.get(first!.userId))?.role).toBe('member');
    const again = await links.resolve(claims('acct_member01', 'admin'));
    expect(again).toEqual(first);
    expect((await t.auth.users.get(first!.userId))?.role).toBe('admin');
  });

  it('does not hand out ownership through a ticket', async () => {
    const m = await links.resolve(claims('acct_member02', 'member'));
    expect(await links.resolve(claims('acct_member02', 'owner'))).toBeNull();
    expect((await t.auth.users.get(m!.userId))?.role).toBe('member');
    expect(await links.resolve(claims('acct_owner001', 'admin'))).toBeNull();
  });

  it('makes one person when the first two visits come at once', async () => {
    const [a, b] = await Promise.all([
      links.resolve(claims('acct_member03', 'member')),
      links.resolve(claims('acct_member03', 'member')),
    ]);
    expect(a).toEqual(b);
  });

  it('keeps a person removed here out, instead of making them again', async () => {
    const m = await links.resolve(claims('acct_member04', 'member'));
    await t.auth.users.remove(m!.userId);
    expect(await links.resolve(claims('acct_member04', 'member'))).toBeNull();
    expect((await t.auth.users.list()).some((p) => p.id === m!.userId)).toBe(false);
  });

  it('refuses a person disabled here', async () => {
    const m = await links.resolve(claims('acct_member05', 'member'));
    await t.auth.users.change(m!.userId, { disabled: true });
    expect(await links.resolve(claims('acct_member05', 'member'))).toBeNull();
    await t.auth.users.change(m!.userId, { disabled: false });
    expect(await links.resolve(claims('acct_member05', 'member'))).toEqual(m);
  });

  const settingsOf = (userId: string) => t.services.settings.all(userId);
  const named = (sub: string, role: TicketClaims['role'], name: string): TicketClaims => ({
    ...claims(sub, role),
    name,
  });

  it('calls a new member by the name their account has', async () => {
    const m = await links.resolve(named('acct_member06', 'member', 'Mira Kaya'));
    expect((await t.auth.users.person(m!.userId))?.displayName).toBe('Mira Kaya');
    expect((await settingsOf(m!.userId)).userName).toBe('Mira Kaya');
  });

  it('follows a renamed account, but keeps a name typed here', async () => {
    const m = await links.resolve(named('acct_member07', 'member', 'Deniz'));
    await links.resolve(named('acct_member07', 'member', 'Deniz Ak'));
    expect((await settingsOf(m!.userId)).userName).toBe('Deniz Ak');
    await t.services.settings.update({ userName: 'Den' }, m!.userId);
    await links.resolve(named('acct_member07', 'member', 'Deniz Akın'));
    expect((await t.auth.users.person(m!.userId))?.displayName).toBe('Deniz Akın');
    expect((await settingsOf(m!.userId)).userName).toBe('Den');
  });

  it('fills the owner’s empty name from the account, never one they gave', async () => {
    const before = (await settingsOf(OWNER_ID)).userName;
    await links.useName(OWNER_ID, 'Ada Lovelace');
    const after = (await settingsOf(OWNER_ID)).userName;
    expect(after).toBe(before ? before : 'Ada Lovelace');
    await t.services.settings.update({ userName: 'Ada' }, OWNER_ID);
    await links.useName(OWNER_ID, 'Ada L.');
    expect((await settingsOf(OWNER_ID)).userName).toBe('Ada');
    await links.useName(OWNER_ID, 'Ada K.', { always: true });
    expect((await settingsOf(OWNER_ID)).userName).toBe('Ada K.');
  });

  it('tells open apps when a name changed, and cuts a long one without splitting a character', async () => {
    let told = 0;
    const watched = new AccountLinks(t.services.ctx.db, () => told++);
    const m = await watched.resolve(named('acct_member08', 'member', 'Ece'));
    expect(told).toBe(1);
    await watched.resolve(named('acct_member08', 'member', 'Ece'));
    expect(told).toBe(1);
    await watched.useName(m!.userId, `${'x'.repeat(79)}😀`);
    expect((await t.auth.users.person(m!.userId))?.displayName).toBe('x'.repeat(79));
    expect(told).toBe(2);
  });

  it('moves the owner to the account that linked the server from here', async () => {
    await links.linkOwner('acct_owner009');
    expect(await links.resolve(claims('acct_owner009', 'owner'))).toEqual({ userId: OWNER_ID });
    expect(await links.resolve(claims('acct_owner001', 'owner'))).toBeNull();
  });
});
