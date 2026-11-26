import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PasswordManager } from '@leafbot/shared';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { schema } from '../src/db';
import {
  bitwarden,
  ManagerError,
  onePassword,
  onePasswordProblem,
  protonPass,
  type DriverFactory,
  type DriverSetup,
  type ManagerEntry,
  type ManagerLogin,
  type OnePasswordModule,
} from '../src/services/password-manager-drivers';
import { MANAGERS_DIR } from '../src/services/password-managers';
import { testServer, type Person, type TestServer } from './helpers';

const TOTP = 'JBSWY3DPEHPK3PXP';
const TOKEN = 'ops_sahte-hizmet-hesabi-jetonu-1234567890';

/** A manager that answers from a list, and counts how often its list and its passwords were read. */
function fakeManager(logins: Record<string, ManagerEntry['urls'] & { login?: ManagerLogin }>) {
  const seen = { setups: [] as DriverSetup[], lists: 0, reads: [] as string[] };
  const make: DriverFactory = (setup) => {
    seen.setups.push(setup);
    if ('token' in setup.secret && setup.secret.token.includes('yanlis')) {
      return {
        entries: () => Promise.reject(new ManagerError('auth')),
        login: () => Promise.reject(new ManagerError('auth')),
      };
    }
    return {
      async entries() {
        seen.lists++;
        if (setup.scope === 'Olmayan') throw new ManagerError('scope');
        return Object.entries(logins).map(([ref, urls]) => ({ ref, urls }));
      },
      async login(ref) {
        seen.reads.push(ref);
        return logins[ref]!.login!;
      },
    };
  };
  return { make, seen };
}

const entry = (urls: ManagerEntry['urls'], login: ManagerLogin) => Object.assign([...urls], { login });

describe('parola yöneticileri', () => {
  let t: TestServer;
  let ayse: Person;
  beforeEach(async () => {
    t = await testServer();
    ayse = await t.person('ayse');
  });
  afterEach(() => t.dispose());

  const logins = () => ({
    a1: entry([{ url: 'https://accounts.ornek.com/giris', exact: false }], {
      username: 'ayse',
      password: 'yonetici-sifresi-1',
      totp: `otpauth://totp/x?secret=${TOTP}`,
    }),
    a2: entry([{ url: 'https://ornek.com', exact: false }], {
      username: 'kasada-olan',
      password: 'yonetici-sifresi-2',
      totp: null,
    }),
    // Over plain http a password is never typed, wherever it comes from.
    a3: entry([{ url: 'http://ornek.com', exact: false }], {
      username: 'duz',
      password: 'yonetici-sifresi-3',
      totp: null,
    }),
    // Filled on this host alone.
    a4: entry([{ url: 'https://tek.baska.example', exact: true }], {
      username: 'tek',
      password: 'yonetici-sifresi-4',
      totp: null,
    }),
  });

  it('bağlanırken bir kez okur; reddedilen jeton ya da olmayan kasa hiçbir şey kaydetmez', async () => {
    const fake = fakeManager(logins());
    t.services.passwordManagers.useDrivers(fake.make);
    const refused = await ayse.api('POST', '/api/password-managers', {
      kind: 'onepassword',
      token: 'ops_yanlis-jeton-1234567890',
    });
    expect(refused.status).toBe(400);
    const noVault = await ayse.api('POST', '/api/password-managers', {
      kind: 'onepassword',
      token: TOKEN,
      scope: 'Olmayan',
    });
    expect(noVault.status).toBe(400);
    expect((await ayse.api<PasswordManager[]>('GET', '/api/password-managers')).body).toEqual([]);
    // The sign-in state of a manager not kept is not left behind either.
    for (const s of fake.seen.setups) expect(existsSync(s.stateDir)).toBe(false);

    const made = await ayse.api<PasswordManager>('POST', '/api/password-managers', {
      kind: 'onepassword',
      token: TOKEN,
      scope: 'Botlar',
    });
    expect(made.status).toBe(200);
    expect(made.body).toMatchObject({
      kind: 'onepassword',
      scope: 'Botlar',
      userId: 'ayse',
      count: 4,
      problem: null,
    });
    // The token never comes back, and it is sealed bound to its row.
    expect(JSON.stringify(made.body)).not.toContain('sahte');
    const [row] = await t.services.ctx.db
      .select()
      .from(schema.passwordManagers)
      .where(eq(schema.passwordManagers.id, made.body.id));
    expect(row!.secret.startsWith('v2:')).toBe(true);
    expect(row!.secret).not.toContain('sahte');
    // One of each kind per owner.
    expect(
      (await ayse.api('POST', '/api/password-managers', { kind: 'onepassword', token: TOKEN })).status,
    ).toBe(409);
    // A member connects one for the team only if they look after the server.
    expect(
      (await ayse.api('POST', '/api/password-managers', { kind: 'protonpass', token: TOKEN, team: true }))
        .status,
    ).toBe(403);
    // Bitwarden needs a folder: the rest of the account stays out of reach.
    expect(
      (
        await ayse.api('POST', '/api/password-managers', {
          kind: 'bitwarden',
          clientId: 'user.x',
          clientSecret: 'y',
          password: 'z',
          scope: '',
        })
      ).status,
    ).toBe(400);

    const dir = join(t.dataDir, MANAGERS_DIR, made.body.id);
    expect(existsSync(dir)).toBe(true);
    expect((await ayse.api('DELETE', `/api/password-managers/${made.body.id}`)).status).toBe(200);
    expect(existsSync(dir)).toBe(false);
  });

  it('kişinin kendi Bitwarden sunucusu bu bilgisayarda ya da iç ağda olamaz; sunucuyu yöneten verebilir', async () => {
    const fake = fakeManager(logins());
    t.services.passwordManagers.useDrivers(fake.make);
    const bitwarden = (server: string) => ({
      kind: 'bitwarden',
      server,
      clientId: 'user.x',
      clientSecret: 'y',
      password: 'z',
      scope: 'Botlar',
    });
    for (const server of ['https://127.0.0.1:8443', 'https://169.254.169.254', 'https://localhost']) {
      expect((await ayse.api('POST', '/api/password-managers', bitwarden(server))).status).toBe(400);
    }
    // Refused before the manager is read, so nothing went to that address.
    expect(fake.seen.setups).toEqual([]);
    const admin = await t.person('yonetici', 'admin');
    const made = await admin.api('POST', '/api/password-managers', bitwarden('https://127.0.0.1:8443'));
    expect(made.status).toBe(200);
    expect(fake.seen.setups.map((s) => s.server)).toEqual(['https://127.0.0.1:8443']);
  });

  it('sayfanın sitesine ait girişleri kasadakilerin ardından verir; parolayı yalnız gerektiğinde okur', async () => {
    const fake = fakeManager(logins());
    t.services.passwordManagers.useDrivers(fake.make);
    await ayse.api('POST', '/api/vault', {
      site: 'ornek.com',
      username: 'kasada-olan',
      password: 'kasa-sifresi',
    });
    const made = (
      await ayse.api<PasswordManager>('POST', '/api/password-managers', { kind: 'protonpass', token: TOKEN })
    ).body;
    const vault = t.services.vault;

    const found = await vault.forHost('mail.ornek.com', undefined, 'ayse');
    // The vault's own comes first; the manager's sign-in with the same username is left out.
    expect(found.map((c) => [c.username, c.password, c.totp])).toEqual([
      ['kasada-olan', 'kasa-sifresi', null],
      ['ayse', 'yonetici-sifresi-1', TOTP],
    ]);
    expect(found[1]!.id).toBe(`pm:${made.id}:a1`);
    expect(found[1]!.site).toBe('ornek.com');
    // Only the sign-ins of this site were read from the manager, never the http one.
    expect(fake.seen.reads.sort()).toEqual(['a1', 'a2']);
    // Marking a manager's sign-in as used has no row to change.
    await expect(vault.used(found[1]!.id)).resolves.toBeUndefined();

    // A website filled on its host alone is not used on another host of the same site.
    expect((await vault.forHost('baska.example', undefined, 'ayse')).map((c) => c.username)).toEqual([]);
    expect((await vault.forHost('tek.baska.example', undefined, 'ayse')).map((c) => c.username)).toEqual([
      'tek',
    ]);

    // The list is read once and kept for a while; a refresh reads it anew.
    const lists = fake.seen.lists;
    await vault.forHost('ornek.com', undefined, 'ayse');
    expect(fake.seen.lists).toBe(lists);
    const refreshed = await ayse.api<PasswordManager>('POST', `/api/password-managers/${made.id}/refresh`);
    expect(refreshed.body.count).toBe(4);
    expect(fake.seen.lists).toBe(lists + 1);

    // A person's own manager is not used for anyone else, nor in a team conversation.
    await t.person('mehmet');
    expect(await vault.forHost('ornek.com', undefined, 'mehmet')).toEqual([]);
    expect(await vault.forHost('ornek.com', undefined, null)).toEqual([]);
    expect(
      (await (await t.person('ali')).api('PATCH', `/api/password-managers/${made.id}`, { scope: 'x' }))
        .status,
    ).toBe(404);
  });

  it('yalnız seçilen botlara açılır; silinen bot listeden çıkar', async () => {
    const fake = fakeManager(logins());
    t.services.passwordManagers.useDrivers(fake.make);
    const bot = await t.bot({ name: 'Alıcı' });
    const other = await t.bot({ name: 'Başka' });
    // Whoever looks after the server may connect one for the whole team.
    const made = (
      await t.api<PasswordManager>('POST', '/api/password-managers', {
        kind: 'onepassword',
        token: TOKEN,
        botIds: [bot.id],
        team: true,
      })
    ).body;
    expect(made.userId).toBeNull();
    const names = async (botId: string | undefined, userId: string | null) =>
      (await t.services.vault.forHost('ornek.com', botId, userId)).map((c) => c.username);
    expect(await names(bot.id, null)).toEqual(['ayse', 'kasada-olan']);
    expect(await names(other.id, null)).toEqual([]);
    expect(await names(undefined, 'ayse')).toEqual([]);
    // A member sees the team's manager but cannot change it.
    expect((await ayse.api<PasswordManager[]>('GET', '/api/password-managers')).body).toHaveLength(1);
    expect((await ayse.api('DELETE', `/api/password-managers/${made.id}`)).status).toBe(403);

    await t.api('POST', `/api/bots/${bot.id}/archive`);
    await t.api('DELETE', `/api/bots/${bot.id}`);
    expect((await t.services.passwordManagers.get(made.id)).botIds).toEqual([]);
  });

  it('okunamayan bir yönetici diğer girişleri engellemez; sorunu satırında kalır', async () => {
    let broken = false;
    t.services.passwordManagers.useDrivers(() => ({
      entries: async () => {
        if (broken) throw new ManagerError('auth');
        return [{ ref: 'r1', urls: [{ url: 'https://ornek.com', exact: false }] }];
      },
      login: async () => ({ username: 'y', password: 'p', totp: null }),
    }));
    const made = (
      await ayse.api<PasswordManager>('POST', '/api/password-managers', { kind: 'onepassword', token: TOKEN })
    ).body;
    await ayse.api('POST', '/api/vault', { site: 'ornek.com', username: 'kasa', password: 'k' });
    broken = true;
    const after = await ayse.api<PasswordManager>('POST', `/api/password-managers/${made.id}/refresh`);
    expect(after.body.problem).toBe('auth');
    expect((await t.services.vault.forHost('ornek.com', undefined, 'ayse')).map((c) => c.username)).toEqual([
      'kasa',
    ]);
  });
});

/**
 * The command-line drivers, run against small stand-in programs that answer as the real ones do
 * and write down how they were called. The real programs and real accounts are never used here.
 */
describe('parola yöneticisi programları', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'leafbot-pm-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  /** A stand-in program: its answers come from `answer`, keyed by its arguments. */
  function program(name: string, body: string) {
    const file = join(dir, name);
    writeFileSync(
      file,
      `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(BW_|BITWARDENCLI_|PROTON_|HOME)/.test(k)));
fs.appendFileSync(${JSON.stringify(join(dir, 'calls.jsonl'))}, JSON.stringify({ args, env }) + '\\n');
const out = (s) => { process.stdout.write(typeof s === 'string' ? s : JSON.stringify(s)); process.exit(0); };
const fail = (s) => { process.stderr.write(s); process.exit(1); };
${body}
fail('unknown: ' + args.join(' '));
`,
    );
    chmodSync(file, 0o755);
    return file;
  }
  const calls = () =>
    readFileSync(join(dir, 'calls.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { args: string[]; env: Record<string, string> });

  it('Bitwarden: API anahtarıyla girer, ana parolayla açar, yalnız seçilen klasörü okur; sırlar argümanda geçmez', async () => {
    const bw = program(
      'bw',
      `const a = args.filter((x) => x !== '--nointeraction').join(' ');
const state = fs.existsSync(process.env.BITWARDENCLI_APPDATA_DIR + '/in') ? 'locked' : 'unauthenticated';
if (a === 'status') out({ status: state });
if (a === 'config server https://bw.ornek.example') out('Saved setting');
if (a === 'login --apikey') {
  if (process.env.BW_CLIENTSECRET !== 'istemci-sirri') fail('Invalid client');
  fs.writeFileSync(process.env.BITWARDENCLI_APPDATA_DIR + '/in', ''); out('You are logged in!');
}
if (a === 'unlock --passwordenv BW_PASSWORD --raw') {
  if (process.env.BW_PASSWORD !== 'ana-parola') fail('Invalid master password.');
  out('oturum-anahtari');
}
if (process.env.BW_SESSION !== 'oturum-anahtari') fail('Vault is locked.');
if (a === 'sync') out('Syncing complete.');
if (a === 'list folders') out([{ id: 'klasor-1', name: 'Botlar' }, { id: 'klasor-2', name: 'Kişisel' }]);
if (a === 'list items --folderid klasor-1') out([
  { id: 'oge-1', type: 1, reprompt: 0, login: { uris: [{ uri: 'https://ornek.com', match: null }, { uri: 'https://tek.ornek.com', match: 1 }] } },
  { id: 'oge-2', type: 1, reprompt: 1, login: { uris: [{ uri: 'https://gizli.example' }] } },
  { id: 'oge-3', type: 3, reprompt: 0 },
  { id: 'oge-4', type: 1, reprompt: 0, login: { username: 'mehmet', password: 'listedeki-sifre', uris: [{ uri: 'https://dort.example' }] } },
]);
if (a === 'get item oge-1') out({ id: 'oge-1', type: 1, reprompt: 0, login: { username: 'ayse', password: 'bw-sifresi', totp: '${TOTP}' } });`,
    );
    const setup = (password: string, scope = 'Botlar'): DriverSetup => ({
      kind: 'bitwarden',
      secret: { clientId: 'user.istemci', clientSecret: 'istemci-sirri', password },
      scope,
      server: 'https://bw.ornek.example',
      stateDir: dir,
    });
    const wrong = bitwarden(setup('yanlis-parola'), undefined, bw);
    await expect(wrong.entries()).rejects.toMatchObject({ problem: 'auth' });
    await expect(bitwarden(setup('ana-parola', 'Yok'), undefined, bw).entries()).rejects.toMatchObject({
      problem: 'scope',
    });

    const d = bitwarden(setup('ana-parola'), undefined, bw);
    expect(await d.entries()).toEqual([
      {
        ref: 'oge-1',
        urls: [
          { url: 'https://ornek.com', exact: false },
          { url: 'https://tek.ornek.com', exact: true },
        ],
      },
      { ref: 'oge-4', urls: [{ url: 'https://dort.example', exact: false }] },
    ]);
    expect(await d.login('oge-1')).toEqual({ username: 'ayse', password: 'bw-sifresi', totp: TOTP });
    // Right after the list, a sign-in it already carried is not read again.
    expect(await d.login('oge-4')).toEqual({ username: 'mehmet', password: 'listedeki-sifre', totp: null });
    expect(
      calls()
        .filter((c) => c.args[0] === 'get')
        .map((c) => c.args[2]),
    ).toEqual(['oge-1']);
    await expect(d.login('--raw')).rejects.toBeInstanceOf(ManagerError);

    const all = calls();
    const argv = JSON.stringify(all.map((c) => c.args));
    for (const secret of ['istemci-sirri', 'ana-parola', 'oturum-anahtari', 'user.istemci']) {
      expect(argv).not.toContain(secret);
    }
    // Its state is kept in the manager's own folder, never the machine user's.
    expect(all.every((c) => c.env.BITWARDENCLI_APPDATA_DIR === dir && c.env.HOME === dir)).toBe(true);
    // The master password goes only to the step that unlocks.
    expect(all.filter((c) => c.env.BW_PASSWORD).every((c) => c.args[0] === 'unlock')).toBe(true);
  });

  it('Proton Pass: kişisel erişim jetonuyla girer, oturum bitince yeniden girer; jeton argümanda geçmez', async () => {
    const pass = program(
      'pass-cli',
      `const a = args.join(' ');
const session = process.env.PROTON_PASS_SESSION_DIR;
const flag = session + '.in';
if (a === 'info') { if (fs.existsSync(flag)) out('Signed in'); fail('Not logged in'); }
if (a === 'login') {
  if (process.env.PROTON_PASS_PERSONAL_ACCESS_TOKEN !== '${TOKEN}') fail('Invalid token');
  fs.writeFileSync(flag, ''); out('Logged in');
}
if (!fs.existsSync(flag)) fail('Session expired');
if (a === 'item list --vault-name Botlar --filter-type login --filter-state active --output json') {
  // The session ends right after this list: the next read signs in again.
  fs.unlinkSync(flag);
  out({ items: [{ id: 'oge1', share_id: 'pay1', title: 'Örnek', content: { content: { Login: { username: 'ayse', urls: ['https://ornek.com'] } } } }, { id: 'kötü id', share_id: 'pay1' }] });
}
if (a === 'item view pass://pay1/oge1/password') out('proton-sifresi\\n');
if (a === 'item view pass://pay1/oge1/username') out('ayse\\n');
if (a === 'item view pass://pay1/oge1/totp?totp=uri') out('otpauth://totp/x?secret=${TOTP}\\n');
if (a === 'item view pass://pay1/oge2/password') out('ikinci-sifre\\n');
if (a === 'item view pass://pay1/oge2/username') out('mehmet\\n');
if (a === 'vault list --output json') out({ vaults: [{ name: 'Botlar', share_id: 'pay1' }] });`,
    );
    const setup = (token: string): DriverSetup => ({
      kind: 'protonpass',
      secret: { token },
      scope: 'Botlar',
      server: null,
      stateDir: dir,
    });
    await expect(
      protonPass(setup('pst_yanlis-jeton-123456789'), undefined, pass).entries(),
    ).rejects.toMatchObject({
      problem: 'auth',
    });
    const d = protonPass(setup(TOKEN), undefined, pass);
    expect(await d.entries()).toEqual([
      { ref: 'pay1/oge1', urls: [{ url: 'https://ornek.com', exact: false }] },
    ]);
    expect(await d.login('pay1/oge1')).toEqual({
      username: 'ayse',
      password: 'proton-sifresi',
      totp: `otpauth://totp/x?secret=${TOTP}`,
    });
    const all = calls();
    expect(JSON.stringify(all.map((c) => c.args))).not.toContain(TOKEN);
    expect(
      all.filter((c) => c.env.PROTON_PASS_PERSONAL_ACCESS_TOKEN).every((c) => c.args[0] === 'login'),
    ).toBe(true);
    // Refused once with the wrong token, then signed in at first and again after the session ran out.
    expect(all.filter((c) => c.args[0] === 'login')).toHaveLength(3);

    // A field the item does not have, with the session still good, is no reason to sign in again.
    expect(await d.login('pay1/oge2')).toEqual({ username: 'mehmet', password: 'ikinci-sifre', totp: null });
    expect(calls().filter((c) => c.args[0] === 'login')).toHaveLength(3);

    // A vault the account does not show is said as such.
    const missing: DriverSetup = { ...setup(TOKEN), scope: 'Yok' };
    await expect(protonPass(missing, undefined, pass).entries()).rejects.toMatchObject({ problem: 'scope' });
  });

  it('kurulu olmayan program "noCli" olarak bildirilir', async () => {
    const d = protonPass(
      { kind: 'protonpass', secret: { token: TOKEN }, scope: '', server: null, stateDir: dir },
      undefined,
      join(dir, 'olmayan-program'),
    );
    await expect(d.entries()).rejects.toMatchObject({ problem: 'noCli' });
  });

  it('1Password: hizmet hesabı jetonuyla SDK üzerinden yalnız seçilen kasanın giriş öğelerini okur', async () => {
    const made: unknown[] = [];
    const sdk = {
      createClient: async (config: { auth: string }) => {
        made.push(config);
        if (config.auth !== TOKEN) throw new Error('invalid service account token');
        return {
          vaults: {
            list: async () => [
              { id: 'k1', title: 'Botlar' },
              { id: 'k2', title: 'Kişisel' },
            ],
          },
          items: {
            list: async (vaultId: string) =>
              vaultId === 'k1'
                ? [
                    {
                      id: 'o1',
                      category: 'Login',
                      websites: [
                        { url: 'https://ornek.com', autofillBehavior: 'AnywhereOnWebsite' },
                        { url: 'https://hic.example', autofillBehavior: 'Never' },
                      ],
                    },
                    { id: 'o2', category: 'SecureNote', websites: [] },
                  ]
                : [{ id: 'o9', category: 'Login', websites: [{ url: 'https://kisisel.example' }] }],
            get: async (vaultId: string, itemId: string) => ({
              id: itemId,
              vaultId,
              fields: [
                { id: 'username', fieldType: 'Text', value: 'ayse' },
                { id: 'password', fieldType: 'Concealed', value: '1p-sifresi' },
                { id: 'tek', fieldType: 'Totp', value: TOTP },
              ],
            }),
          },
        };
      },
    };
    const load = async () => sdk as unknown as OnePasswordModule;
    const setup = (token: string, scope = 'Botlar'): DriverSetup => ({
      kind: 'onepassword',
      secret: { token },
      scope,
      server: null,
      stateDir: dir,
    });
    await expect(onePassword(setup('yanlis'), load).entries()).rejects.toMatchObject({ problem: 'auth' });
    // No network is not a refused token.
    const offline = async () =>
      ({
        createClient: async () => {
          throw new Error('error sending request: connection refused');
        },
      }) as unknown as OnePasswordModule;
    await expect(onePassword(setup(TOKEN), offline).entries()).rejects.toMatchObject({ problem: 'failed' });
    class RateLimitExceededError extends Error {}
    expect(onePasswordProblem(new RateLimitExceededError('unauthorized burst')).problem).toBe('failed');
    await expect(onePassword(setup(TOKEN, 'Yok'), load).entries()).rejects.toMatchObject({
      problem: 'scope',
    });
    const d = onePassword(setup(TOKEN), load);
    expect(await d.entries()).toEqual([{ ref: 'k1/o1', urls: [{ url: 'https://ornek.com', exact: false }] }]);
    expect(await d.login('k1/o1')).toEqual({ username: 'ayse', password: '1p-sifresi', totp: TOTP });
    await expect(d.login('../o1')).rejects.toBeInstanceOf(ManagerError);
  });
});
