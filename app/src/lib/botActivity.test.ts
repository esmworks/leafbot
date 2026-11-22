import { describe, expect, it } from 'vitest';
import { activityOf, botState, type ActivityInput } from './botActivity';

const base: ActivityInput = { state: 'idle', pendingApprovals: 0, streaming: false, browsing: false };
const of = (patch: Partial<ActivityInput>) => activityOf({ ...base, ...patch });

describe('avatarın gösterdiği iş', () => {
  it('boştayken durur', () => {
    expect(of({})).toBe('idle');
    // A leftover stream or browser after the turn ends does not animate the bot.
    expect(of({ streaming: true, browsing: true })).toBe('idle');
  });

  it('çalışan turda düşünür, yazar ya da tarayıcıda gezer', () => {
    expect(of({ state: 'running' })).toBe('thinking');
    expect(of({ state: 'running', streaming: true })).toBe('writing');
    expect(of({ state: 'running', streaming: true, browsing: true })).toBe('browsing');
  });

  it('sırada bekler', () => {
    expect(of({ state: 'queued' })).toBe('queued');
  });

  it('onay beklemesi her şeyin önüne geçer', () => {
    expect(of({ state: 'waiting' })).toBe('waiting');
    expect(of({ state: 'running', pendingApprovals: 2, browsing: true })).toBe('waiting');
  });
});

describe('botun durumu', () => {
  it('ana sohbeti boşken başka konuşmadaki işi gösterir', () => {
    // A ticket's or another bot's request runs outside the conversation the bot opens to.
    expect(botState('idle', 'running')).toBe('running');
    expect(botState(undefined, 'queued')).toBe('queued');
  });

  it('ana sohbetin canlı durumu çekilenin önüne geçer', () => {
    expect(botState('running', 'idle')).toBe('running');
    expect(botState('waiting', 'running')).toBe('waiting');
    expect(botState(undefined, undefined)).toBe('idle');
    expect(botState('idle', undefined)).toBe('idle');
  });
});
