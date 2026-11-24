import type { ProviderSignIn } from '@leafbot/shared';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bundledClaude, signInUrl } from '../src/services/claude-sign-in';
import { testServer, waitFor, type TestServer } from './helpers';

const TOKEN = `sk-ant-oat01-${'a1b2'.repeat(20)}tokn`;
const PAGE = 'https://claude.com/cai/oauth/authorize?code=true&client_id=x';

/**
 * A stand-in for Claude Code's `auth login`: it prints the sign-in page the way the real one does
 * (as a terminal link), waits for a pasted code, and saves the login only for the right one.
 */
function fakeClaude(dir: string, page = PAGE): string {
  const file = join(dir, 'claude');
  writeFileSync(
    file,
    `#!/bin/sh
printf '%s\\n' "$*" > "${dir}/args"
printf 'Opening browser to sign in\\342\\200\\246\\n'
printf "If the browser didn't open, visit: \\033]8;;${page}\\007${page}\\033]8;;\\007\\n"
printf 'Paste code here if prompted > '
read code
if [ "$code" = "good#state" ]; then echo 'Login successful.'; exit 0; fi
echo 'Authentication failed: Invalid authorization code' >&2
exit 1
`,
  );
  chmodSync(file, 0o755);
  return file;
}

describe.skipIf(process.platform === 'win32')('Claude ile giriş', () => {
  let t: TestServer;
  let dir: string;
  const signIn = (id: string) => t.api<ProviderSignIn>('GET', `/api/claude/sign-in/${id}`);
  const until = (id: string, status: ProviderSignIn['status']) =>
    waitFor(async () => {
      const s = (await signIn(id)).body;
      return s.status === status && s;
    });

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'leafbot-claude-'));
    t = await testServer({}, { claudeExecutable: fakeClaude(dir) });
  });
  afterEach(async () => {
    await t.dispose();
    rmSync(dir, { recursive: true, force: true });
  });

  it('giriş sayfasını gösterir, sayfadaki kodla girişi bitirir ve kayıtlı belirteç yerine girişi kullanır', async () => {
    // A token saved earlier would come before the new login, so signing in replaces it.
    await t.api('PUT', '/api/claude/auth', { kind: 'token', value: TOKEN });
    const started = await t.api<ProviderSignIn>('POST', '/api/claude/sign-in');
    expect(started.status).toBe(200);
    const waiting = await until(started.body.id, 'waiting');
    expect(waiting).toMatchObject({ provider: 'claude', url: PAGE, needsPaste: true, error: null });
    expect(readFileSync(join(dir, 'args'), 'utf8').trim()).toBe('auth login --claudeai');

    const pasted = await t.api<ProviderSignIn>('POST', `/api/claude/sign-in/${started.body.id}/paste`, {
      input: ' good#state \n',
    });
    expect(pasted.body.needsPaste).toBe(false);
    await until(started.body.id, 'done');
    expect((await t.api('GET', '/api/claude/auth')).body).toEqual({ kind: 'login', hint: null });
  });

  it('yanlış kodda Claude Code’un nedenini gösterir', async () => {
    const { body } = await t.api<ProviderSignIn>('POST', '/api/claude/sign-in');
    await until(body.id, 'waiting');
    await t.api('POST', `/api/claude/sign-in/${body.id}/paste`, { input: 'bad#state' });
    const failed = await until(body.id, 'error');
    expect(failed.error).toBe('Authentication failed: Invalid authorization code');
    // Nothing waits for a code any more.
    expect((await t.api('POST', `/api/claude/sign-in/${body.id}/paste`, { input: 'x' })).status).toBe(409);
  });

  it('vazgeçilen girişin programını kapatır; yeni giriş eskisini bitirir', async () => {
    const first = (await t.api<ProviderSignIn>('POST', '/api/claude/sign-in')).body;
    await until(first.id, 'waiting');
    const second = (await t.api<ProviderSignIn>('POST', '/api/claude/sign-in')).body;
    expect((await signIn(first.id)).body.status).toBe('cancelled');
    await until(second.id, 'waiting');
    expect((await t.api('DELETE', `/api/claude/sign-in/${second.id}`)).status).toBe(200);
    expect((await signIn(second.id)).body.status).toBe('cancelled');
  });

  it("Claude'un sitelerinden olmayan bir sayfayı göstermez", async () => {
    await t.dispose();
    t = await testServer({}, { claudeExecutable: fakeClaude(dir, 'https://claude.ai.example.com/login') });
    const { body } = await t.api<ProviderSignIn>('POST', '/api/claude/sign-in');
    await new Promise((r) => setTimeout(r, 300));
    expect((await signIn(body.id)).body).toMatchObject({ status: 'starting', url: null, needsPaste: false });
  });

  it('girişi yalnızca sunucuyu yönetenler başlatır', async () => {
    const member = await t.person('ayse');
    expect((await member.api('POST', '/api/claude/sign-in')).status).toBe(403);
  });
});

describe('Claude girişinin programı', () => {
  it('Claude Code olmayan sunucuda token ya da anahtar yolunu söyler', async () => {
    const t = await testServer({}, { claudeExecutable: null });
    try {
      const r = await t.api<{ error: string }>('POST', '/api/claude/sign-in');
      expect(r.status).toBe(501);
    } finally {
      await t.dispose();
    }
  });

  it("Agent SDK'nın getirdiği Claude Code'u bulur; ayrıca kurulum gerekmez", () => {
    const path = bundledClaude();
    expect(path).not.toBeNull();
    expect(existsSync(path!)).toBe(true);
  });

  it('terminal bağlantısının içinden yalnızca Claude sitesindeki https sayfasını alır', () => {
    const link = (url: string) => `\u001b]8;;${url}\u0007${url}\u001b]8;;\u0007`;
    expect(signInUrl(`visit: ${link(PAGE)}\n`)).toBe(PAGE);
    expect(signInUrl('visit: http://claude.ai/oauth')).toBeNull();
    expect(signInUrl('visit: https://claude.ai.evil.example/x')).toBeNull();
    expect(signInUrl('a https://evil.example/x then https://platform.claude.com/oauth/code')).toBe(
      'https://platform.claude.com/oauth/code',
    );
  });
});
