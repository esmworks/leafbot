import { afterEach, describe, expect, it, vi } from 'vitest';
import { TurnManager } from '../src/runtime/turns';
import { testServer, type TestServer } from './helpers';

describe('sunucunun açılışı', () => {
  let t: TestServer | undefined;
  afterEach(async () => {
    vi.restoreAllMocks();
    await t?.dispose();
  });

  it('bir parçası açılamasa da sunucu açılır ve nedenini günlüğe yazar', async () => {
    vi.spyOn(TurnManager.prototype, 'recover').mockRejectedValue(new Error('okunamayan satır'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    t = await testServer();
    expect((await t.api('GET', '/api/health')).status).toBe(200);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('okunamayan satır'));
  });
});
