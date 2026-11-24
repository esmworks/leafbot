import { createHash } from 'node:crypto';
import { GitAuthor } from '@leafbot/shared';

/** The account a GitHub key belongs to, as the author its commits are written by; null when unknown. */
export type GitAuthorLookup = (token: string) => Promise<GitAuthor | null>;

const USER_URL = 'https://api.github.com/user';
const TIMEOUT_MS = 4000;
/** An account does not change under its key; a while is enough to catch a key that was replaced. */
const FOUND_MS = 6 * 60 * 60 * 1000;
/** A lookup that failed is tried again soon: GitHub may have been down, or the key just fixed. */
const MISSED_MS = 5 * 60 * 1000;
const MAX_ENTRIES = 200;
/** GitHub's own rule for a username: letters, digits and single hyphens, at most 39 characters. */
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

/**
 * The author for commits pushed with a GitHub key: the key's own account, with the private address
 * GitHub gives every account (`<id>+<login>@users.noreply.github.com`). GitHub credits a commit to
 * whichever account owns its address, so this one goes to the right person and shows no real email.
 *
 * The key goes to api.github.com alone, the API of the github.com it was saved for, and a
 * redirect is not followed with it. Answers are kept by the key's hash, never the key. A lookup
 * that fails or takes too long gives null: the command then runs with git's own settings.
 */
export function githubAuthorLookup(fetchFn: typeof fetch = fetch, now = () => Date.now()): GitAuthorLookup {
  const cache = new Map<string, { author: GitAuthor | null; until: number }>();
  return async (token) => {
    const key = createHash('sha256').update(token).digest('hex');
    const hit = cache.get(key);
    if (hit && hit.until > now()) return hit.author;
    const author = await ask(fetchFn, token);
    cache.delete(key);
    if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value as string);
    cache.set(key, { author, until: now() + (author ? FOUND_MS : MISSED_MS) });
    return author;
  };
}

async function ask(fetchFn: typeof fetch, token: string): Promise<GitAuthor | null> {
  try {
    const res = await fetchFn(USER_URL, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'leafbot',
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status !== 200) return null;
    return authorOf(await res.json());
  } catch {
    return null;
  }
}

/** The author for an account as GitHub's /user describes it; null for anything else. */
export function authorOf(user: unknown): GitAuthor | null {
  const { id, login } = (user ?? {}) as { id?: unknown; login?: unknown };
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) return null;
  if (typeof login !== 'string' || !LOGIN.test(login)) return null;
  const author = GitAuthor.safeParse({ name: login, email: `${id}+${login}@users.noreply.github.com` });
  return author.success ? author.data : null;
}
