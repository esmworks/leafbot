import { describe, expect, it } from 'vitest';
import { screenBotOf } from './screen';

describe('screenBotOf', () => {
  it('names the bot only on the screen page', () => {
    expect(screenBotOf('?screen=bot-1')).toBe('bot-1');
    expect(screenBotOf('?thread=x&screen=bot%201')).toBe('bot 1');
    expect(screenBotOf('?screen=')).toBeNull();
    expect(screenBotOf('')).toBeNull();
    expect(screenBotOf('?quick=1')).toBeNull();
  });
});
