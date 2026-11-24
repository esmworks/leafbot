import { describe, expect, it } from 'vitest';
import { authorOf, githubAuthorLookup } from '../src/services/github-author';

const KEY = 'github_pat_0123456789abcdef';

/** A stand-in for GitHub's /user: answers `body` with `status`, and keeps what it was asked. */
function fakeGithub(status = 200, body: unknown = { id: 208078507, login: 'erhanerbas' }) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

describe('GitHub anahtarının hesabı, commit yazarı olarak', () => {
  it("anahtarın hesabını GitHub'ın gizli adresiyle verir; anahtar yalnız api.github.com'a gider", async () => {
    const gh = fakeGithub();
    const author = await githubAuthorLookup(gh.fn)(KEY);
    expect(author).toEqual({ name: 'erhanerbas', email: '208078507+erhanerbas@users.noreply.github.com' });
    expect(gh.calls).toHaveLength(1);
    expect(gh.calls[0]!.url).toBe('https://api.github.com/user');
    expect((gh.calls[0]!.init.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);
    // A redirect would carry the key elsewhere; it is not followed.
    expect(gh.calls[0]!.init.redirect).toBe('manual');
  });

  it('bulduğunu saatlerce, bulamadığını kısa süre tutar', async () => {
    let now = 0;
    const found = fakeGithub();
    const lookup = githubAuthorLookup(found.fn, () => now);
    await lookup(KEY);
    now += 60 * 60 * 1000;
    await lookup(KEY);
    expect(found.calls).toHaveLength(1);

    const missed = fakeGithub(401, { message: 'Bad credentials' });
    const retry = githubAuthorLookup(missed.fn, () => now);
    expect(await retry(KEY)).toBeNull();
    expect(await retry(KEY)).toBeNull();
    expect(missed.calls).toHaveLength(1);
    now += 6 * 60 * 1000;
    await retry(KEY);
    expect(missed.calls).toHaveLength(2);
  });

  it('GitHub erişilemezse ya da yönlendirirse komutu durdurmaz, yazar vermez', async () => {
    const down = (async () => {
      throw new Error('getaddrinfo ENOTFOUND api.github.com');
    }) as unknown as typeof fetch;
    expect(await githubAuthorLookup(down)(KEY)).toBeNull();
    expect(await githubAuthorLookup(fakeGithub(302).fn)(KEY)).toBeNull();
  });

  it('GitHub kullanıcı adına ve sayısal kimliğe uymayan bir yanıttan yazar çıkarmaz', () => {
    expect(authorOf({ id: 1, login: 'a-b' })).toEqual({
      name: 'a-b',
      email: '1+a-b@users.noreply.github.com',
    });
    expect(authorOf({ id: '1', login: 'ab' })).toBeNull();
    expect(authorOf({ id: 0, login: 'ab' })).toBeNull();
    expect(authorOf({ id: 1, login: 'a>b' })).toBeNull();
    expect(authorOf({ id: 1, login: 'ab\nGIT_AUTHOR' })).toBeNull();
    expect(authorOf({ id: 1, login: '-ab' })).toBeNull();
    expect(authorOf({ id: 1, login: 'a'.repeat(40) })).toBeNull();
    expect(authorOf(null)).toBeNull();
  });
});
