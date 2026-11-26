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

  it('forgets the link when the person is removed', async () => {
    const m = await links.resolve(claims('acct_member04', 'member'));
    await t.auth.users.remove(m!.userId);
    const again = await links.resolve(claims('acct_member04', 'member'));
    expect(again?.userId).not.toBe(m!.userId);
  });
});
