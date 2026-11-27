import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ROUTE_RULES } from '../src/access-rules';
import { testServer, type TestServer } from './helpers';

describe('erişim kuralları', () => {
  let t: TestServer;
  beforeAll(async () => {
    t = await testServer();
  });
  afterAll(() => t.dispose());

  /** Signed-in routes as registered; HEAD follows GET. */
  const signedIn = () =>
    [...new Set(t.routes)]
      .filter((r) => !r.startsWith('HEAD '))
      .filter((r) => {
        const path = r.slice(r.indexOf(' ') + 1);
        return path.startsWith('/api/') && !path.includes('*');
      });

  it('oturum isteyen her ucun bir kuralı var', async () => {
    const open = new Set(['/api/health', '/api/access', '/api/session']);
    const missing = signedIn().filter((r) => {
      const path = r.slice(r.indexOf(' ') + 1);
      if (open.has(path) || path.startsWith('/api/hooks/') || path.startsWith('/api/connections/oauth/'))
        return false;
      if (path.startsWith('/api/email/inbound')) return false;
      return !(r in ROUTE_RULES);
    });
    expect(missing).toEqual([]);
  });

  it('tabloda artık olmayan uç kalmaz', () => {
    const known = new Set(t.routes);
    expect(Object.keys(ROUTE_RULES).filter((r) => !known.has(r))).toEqual([]);
  });
});
