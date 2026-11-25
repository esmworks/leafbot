import { describe, expect, it } from 'vitest';
import { MacRequest, secretPlace, stripAnsi } from './mac';

describe('commands on the person’s computer', () => {
  it('names the secret place a command or folder touches', () => {
    expect(secretPlace('cat ~/.ssh/id_ed25519')).toBe('.ssh');
    expect(secretPlace('ls', '/Users/a/.aws')).toBe('.aws');
    expect(secretPlace('cat .env.local')).toBe('.env');
    expect(secretPlace('security find-generic-password -s x')).toBe('Keychain');
    expect(secretPlace('gcloud auth', '/Users/a/.config/gcloud')).toBe('.config');
    expect(secretPlace('cat ~/.npmrc')).toBe('credentials');
  });

  it('lets ordinary work through', () => {
    expect(secretPlace('npm test', '/Users/a/projects/shop')).toBeNull();
    expect(secretPlace('git status', '/Users/a/environment')).toBeNull();
    expect(secretPlace('ls -la', '/Users/a/sshfs-notes')).toBeNull();
  });

  it('takes terminal colours out of output', () => {
    expect(stripAnsi('\u001b[32mok\u001b[0m done')).toBe('ok done');
  });

  it('checks each command request', () => {
    expect(
      MacRequest.safeParse({ op: 'run', id: 'j1', command: 'ls', cwd: '/', bot: 'B', waitMs: 1000 }).success,
    ).toBe(true);
    expect(
      MacRequest.safeParse({ op: 'run', id: '../x', command: 'ls', cwd: '/', bot: 'B', waitMs: 1 }).success,
    ).toBe(false);
    expect(
      MacRequest.safeParse({ op: 'run', id: 'j1', command: 'ls', cwd: '/', bot: 'B', waitMs: 60_000 })
        .success,
    ).toBe(false);
  });
});
