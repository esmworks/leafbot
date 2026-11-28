import { describe, expect, it } from 'vitest';
import { helperState, macMenuShape, offerStep } from './computer-offer';

describe('the helper', () => {
  it('tells a system without one from an install that lost it', () => {
    expect(helperState(false, false)).toBe('unsupported');
    expect(helperState(true, false)).toBe('missing');
    expect(helperState(true, true)).toBe('ok');
  });
});

describe('a page asking to offer this computer', () => {
  const base = { helper: 'ok' as const, listed: ['a', 'b'], chosen: null, on: false, serverId: 'a' };

  it('is refused without a helper', () => {
    expect(offerStep({ ...base, helper: 'missing' })).toEqual({ do: 'refuse' });
    expect(offerStep({ ...base, helper: 'unsupported' })).toEqual({ do: 'refuse' });
  });

  it('is refused for a server the account does not list', () => {
    expect(offerStep({ ...base, serverId: 'elsewhere' })).toEqual({ do: 'refuse' });
  });

  it('asks first when none was chosen', () => {
    expect(offerStep(base)).toEqual({ do: 'ask', moveFrom: null });
  });

  it('asks first when chosen but off', () => {
    expect(offerStep({ ...base, chosen: 'a' })).toEqual({ do: 'ask', moveFrom: null });
  });

  it('asks first, naming the server it leaves, when another was chosen', () => {
    expect(offerStep({ ...base, chosen: 'b', on: true })).toEqual({ do: 'ask', moveFrom: 'b' });
  });

  it('connects again without asking when already on for that server', () => {
    expect(offerStep({ ...base, chosen: 'a', on: true })).toEqual({ do: 'restart' });
  });
});

describe('the menu bar', () => {
  it('shows nothing without a helper', () => {
    expect(macMenuShape({ helper: 'missing', linked: true, accountServers: 1 })).toBe('none');
  });

  it('shows nothing to a person with no account servers', () => {
    expect(macMenuShape({ helper: 'ok', linked: false, accountServers: 0 })).toBe('none');
  });

  it('names the missing step when the account lists servers but none was chosen', () => {
    expect(macMenuShape({ helper: 'ok', linked: false, accountServers: 2 })).toBe('chooseServer');
  });

  it('shows the switch once a server was chosen', () => {
    expect(macMenuShape({ helper: 'ok', linked: true, accountServers: 2 })).toBe('switch');
  });
});
