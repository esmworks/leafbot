import { describe, expect, it } from 'vitest';
import { sandboxOptions, sessionSettings, withCompactWindow } from '../src/engine/claude';
import { advisorFor, claudeFamily } from '../src/runtime/turns';
import { probeShellSandbox } from '../src/shell-sandbox';

describe('Bash yalıtımı', () => {
  const sb = {
    cwd: '/veri/workspaces/bots/a/threads/t',
    additionalDirectories: ['/veri/workspaces/bots/a/files'],
    writable: ['/veri/workspaces/bots/a/threads/t'],
    internet: true,
    readOnly: false,
  };

  it('ev, veri ve Claude giriş klasörlerini okumaya kapatır, botun kendi klasörlerini açar', () => {
    const o = sandboxOptions(sb, ['/home/u', '/veri', '/veri/claude', '/veri']);
    expect(o.sandbox?.filesystem?.denyRead).toEqual(['/home/u', '/veri', '/veri/claude']);
    expect(o.sandbox?.filesystem?.allowRead).toEqual([sb.cwd, ...sb.additionalDirectories]);
    expect(o.sandbox?.failIfUnavailable).toBe(true);
    expect(o.sandbox?.allowUnsandboxedCommands).toBe(false);
  });

  it('macOS yalıtımı her zaman var sayar, desteklenmeyen sistemde çalışmıyor der', async () => {
    expect(await probeShellSandbox('darwin')).toEqual({ status: 'ok', detail: null });
    expect((await probeShellSandbox('win32')).status).toBe('unavailable');
  });
});

describe('özetleme sınırı', () => {
  it("ayar yoksa 200 bin verir, 0 Claude'un kendi değerine bırakır", () => {
    const base = { cleanupPeriodDays: 3650 };
    expect(withCompactWindow(base)).toEqual({ cleanupPeriodDays: 3650, autoCompactWindow: 200_000 });
    expect(withCompactWindow(base, 400_000)).toMatchObject({ autoCompactWindow: 400_000 });
    expect(withCompactWindow(base, 0)).toEqual(base);
  });

  it('danışman botun kendi modelinin ailesine bakar; başka motora ve kapalı ayara gitmez', () => {
    expect(claudeFamily('claude-opus-5-5')).toBe('opus');
    expect(claudeFamily('opus[1m]')).toBe('opus');
    expect(claudeFamily('Sonnet')).toBe('sonnet');
    expect(advisorFor('claude', 'sonnet', 'opus')).toEqual({ advisorModel: 'opus' });
    expect(advisorFor('claude', 'claude-opus-5-5', 'opus')).toEqual({});
    expect(advisorFor('claude', 'opus[1m]', 'opus')).toEqual({});
    expect(advisorFor('claude', 'sonnet', '')).toEqual({});
    expect(advisorFor('pi', 'openrouter/x', 'opus')).toEqual({});
  });

  it('danışman yalnızca seçildiyse CLI ayarlarına girer', () => {
    const base = { cleanupPeriodDays: 3650 };
    expect(sessionSettings(base, { compactWindow: 0 })).toEqual(base);
    expect(sessionSettings(base, { compactWindow: 0, advisorModel: '' })).toEqual(base);
    expect(sessionSettings(base, { advisorModel: 'opus' })).toEqual({
      cleanupPeriodDays: 3650,
      autoCompactWindow: 200_000,
      advisorModel: 'opus',
    });
  });
});
