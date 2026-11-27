import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  isOfflineError,
  startUpdates,
  updateStep,
  type Updater,
  type Updates,
  type UpdateState,
} from './updates';

class FakeUpdater extends EventEmitter implements Updater {
  autoDownload = false;
  autoInstallOnAppQuit = false;
  checks = 0;
  installs: [boolean | undefined, boolean | undefined][] = [];
  found: { isUpdateAvailable: boolean; updateInfo: { version: string } } | Error | null = null;
  checkForUpdates() {
    this.checks++;
    return this.found instanceof Error ? Promise.reject(this.found) : Promise.resolve(this.found);
  }
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean) {
    this.installs.push([isSilent, isForceRunAfter]);
  }
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('masaüstü güncellemeleri', () => {
  let updater: FakeUpdater;
  let updates: Updates | null = null;
  const steps: string[] = [];

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
    updater = new FakeUpdater();
    steps.length = 0;
  });
  afterEach(() => {
    updates?.stop();
    vi.useRealTimers();
  });

  function start(answer: boolean) {
    updates = startUpdates({
      updater,
      everyMs: 1000,
      installTimeoutMs: 5000,
      onInstallFailed: (version, message) => steps.push(`install failed ${version}: ${message}`),
      ask: async (version) => {
        steps.push(`ask ${version}`);
        return answer;
      },
      beforeInstall: async () => {
        steps.push('server stopped');
      },
      onReady: (version) => steps.push(`ready ${version}`),
      warn: (message) => steps.push(message),
    });
    return updates;
  }

  it('açılışta ve aralıklarla arar, indirilen sürümü kapanışta yükler', () => {
    start(false);
    expect(updater.autoDownload).toBe(true);
    expect(updater.autoInstallOnAppQuit).toBe(true);
    expect(updater.checks).toBe(1);
    vi.advanceTimersByTime(2500);
    expect(updater.checks).toBe(3);
  });

  it('kabul edilirse önce sunucuyu durdurur, sonra sessizce yükleyip yeniden açar', async () => {
    start(true);
    updater.emit('update-downloaded', { version: '0.2.1' });
    await flush();
    expect(steps).toEqual(['ready 0.2.1', 'ask 0.2.1', 'server stopped']);
    expect(updater.installs).toEqual([[true, true]]);
  });

  it('sonraya bırakılırsa bir daha sormaz ve aramayı keser; menüden yüklenebilir', async () => {
    const { install } = start(false);
    updater.emit('update-downloaded', { version: '0.2.1' });
    await flush();
    updater.emit('update-downloaded', { version: '0.2.1' });
    vi.advanceTimersByTime(5000);
    await flush();
    expect(steps).toEqual(['ready 0.2.1', 'ask 0.2.1']);
    expect(updater.checks).toBe(1);
    expect(updater.installs).toEqual([]);

    await install();
    await install();
    expect(updater.installs).toEqual([[true, true]]);
  });

  it('indirilmiş sürüm yokken yüklemez; arama hatasını günlüğe yazar', async () => {
    const { install } = start(true);
    await install();
    expect(updater.installs).toEqual([]);
    updater.emit('error', new Error('net::ERR_INTERNET_DISCONNECTED'));
    expect(steps).toEqual(['update check failed: net::ERR_INTERNET_DISCONNECTED']);
  });

  it('keeps the version waiting when the person declines to restart while bots work', async () => {
    let allow = false;
    updates = startUpdates({
      updater,
      everyMs: 1000,
      ask: async () => true,
      confirmInstall: async () => {
        steps.push('confirm');
        return allow;
      },
      beforeInstall: async () => {
        steps.push('server stopped');
      },
      onReady: (version) => steps.push(`ready ${version}`),
      warn: (message) => steps.push(message),
    });
    updater.emit('update-downloaded', { version: '0.2.1' });
    await flush();
    expect(steps).toEqual(['ready 0.2.1', 'confirm']);
    expect(updater.installs).toEqual([]);

    allow = true;
    await updates.install();
    expect(steps).toEqual(['ready 0.2.1', 'confirm', 'confirm', 'server stopped']);
    expect(updater.installs).toEqual([[true, true]]);
  });

  it('answers a check the person started with what it found, and why it failed', async () => {
    const { checkNow } = start(false);
    expect(await checkNow()).toEqual({ status: 'current' });

    updater.found = { isUpdateAvailable: true, updateInfo: { version: '0.3.0' } };
    expect(await checkNow()).toEqual({ status: 'downloading', version: '0.3.0' });

    updater.found = new Error('net::ERR_INTERNET_DISCONNECTED');
    expect(await checkNow()).toEqual({
      status: 'failed',
      offline: true,
      message: 'net::ERR_INTERNET_DISCONNECTED',
    });
    updater.found = new Error('Cannot parse latest-mac.yml');
    expect(await checkNow()).toMatchObject({ status: 'failed', offline: false });

    updater.emit('update-downloaded', { version: '0.3.0' });
    await flush();
    expect(await checkNow()).toEqual({ status: 'ready', version: '0.3.0' });
  });

  it('tells a network failure from other errors', () => {
    expect(isOfflineError('getaddrinfo ENOTFOUND github.com')).toBe(true);
    expect(isOfflineError('net::ERR_CONNECTION_REFUSED')).toBe(true);
    expect(isOfflineError('HttpError: 404')).toBe(false);
  });
  it('lets the person try again when the installer fails, and tells the caller', async () => {
    const { install } = start(false);
    updater.emit('update-downloaded', { version: '0.2.1' });
    await flush();
    await install();
    expect(updater.installs).toHaveLength(1);

    updater.emit('error', new Error('code signature invalid'));
    expect(steps).toContain('install failed 0.2.1: code signature invalid');

    await install();
    expect(updater.installs).toHaveLength(2);
  });

  it('counts an app that does not quit after the installer started as a failed install', async () => {
    const { install } = start(false);
    updater.emit('update-downloaded', { version: '0.2.1' });
    await flush();
    await install();
    vi.advanceTimersByTime(4999);
    expect(steps.some((line) => line.startsWith('install failed'))).toBe(false);
    vi.advanceTimersByTime(1);
    expect(steps).toContain('install failed 0.2.1: the app did not quit for the installer');

    await install();
    expect(updater.installs).toHaveLength(2);
  });

  it('counts a quitAndInstall that throws as a failed install', async () => {
    updater.quitAndInstall = () => {
      throw new Error('no installer');
    };
    const { install } = start(false);
    updater.emit('update-downloaded', { version: '0.2.1' });
    await flush();
    await install();
    expect(steps).toContain('install failed 0.2.1: no installer');
  });

  it('still starts the installer when the server could not be stopped cleanly', async () => {
    updates = startUpdates({
      updater,
      everyMs: 1000,
      ask: async () => true,
      beforeInstall: async () => {
        throw new Error('stuck');
      },
      onReady: () => undefined,
      warn: (message) => steps.push(message),
    });
    updater.emit('update-downloaded', { version: '0.2.1' });
    await flush();
    expect(updater.installs).toEqual([[true, true]]);
    expect(steps).toEqual(['could not stop the server before installing: stuck']);
  });
});

describe('updateStep', () => {
  const ready: UpdateState = { kind: 'ready', version: '1.0.0' };

  it('asks once per downloaded version and ignores a repeat', () => {
    const first = updateStep({ kind: 'idle' }, { kind: 'downloaded', version: '1.0.0' });
    expect(first.state).toEqual({ kind: 'asking', version: '1.0.0' });
    expect(first.effects.map((e) => e.kind)).toEqual(['onReady', 'ask']);
    expect(updateStep(first.state, { kind: 'downloaded', version: '1.0.0' }).effects).toEqual([]);
  });

  it('ignores an answer meant for an older version', () => {
    const asking: UpdateState = { kind: 'asking', version: '2.0.0' };
    expect(updateStep(asking, { kind: 'askAnswered', version: '1.0.0', yes: true }).state).toBe(asking);
  });

  it('goes through confirming only when something must be confirmed', () => {
    expect(updateStep(ready, { kind: 'install' }, true).state.kind).toBe('confirming');
    expect(updateStep(ready, { kind: 'install' }, false).state.kind).toBe('stopping');
    expect(
      updateStep({ kind: 'confirming', version: '1.0.0' }, { kind: 'confirmAnswered', yes: false }).state,
    ).toEqual(ready);
  });

  it('does nothing to an install already under way', () => {
    for (const kind of ['confirming', 'stopping', 'installing'] as const) {
      const state: UpdateState = { kind, version: '1.0.0' };
      expect(updateStep(state, { kind: 'install' })).toEqual({ state, effects: [] });
    }
    expect(updateStep({ kind: 'idle' }, { kind: 'install' }).state.kind).toBe('idle');
  });

  it('returns to ready from a failed install', () => {
    const result = updateStep(
      { kind: 'installing', version: '1.0.0' },
      { kind: 'installError', message: 'x' },
    );
    expect(result.state).toEqual(ready);
    expect(result.effects.map((e) => e.kind)).toEqual(['warn', 'installFailed']);
  });
});
