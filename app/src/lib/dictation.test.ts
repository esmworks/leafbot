import { describe, expect, it } from 'vitest';
import { dictationError, spokenLanguage } from './dictation';

describe('dictationError', () => {
  it('says where to turn the microphone on when permission is refused', () => {
    expect(dictationError('NotAllowedError', 'Permission denied', false).key).toBe('chat.micDenied');
    expect(dictationError('SecurityError', 'x', false).key).toBe('chat.micDenied');
    expect(dictationError('not-allowed', 'not-allowed', false).key).toBe('chat.micDenied');
  });

  it('points the desktop app at the system settings instead', () => {
    expect(dictationError('NotAllowedError', 'x', true).key).toBe('chat.micDeniedDesktop');
  });

  it('tells a missing microphone from a busy one', () => {
    expect(dictationError('NotFoundError', 'x', false).key).toBe('chat.micMissing');
    expect(dictationError('NotReadableError', 'x', false).key).toBe('chat.micBusy');
    expect(dictationError('AbortError', 'x', false).key).toBe('chat.micBusy');
  });

  it('keeps the browser message for anything else', () => {
    expect(dictationError('TypeError', 'odd', false)).toEqual({ message: 'odd' });
  });
});

describe('spokenLanguage', () => {
  it('asks for the app language, a set one, or none so the service can tell', () => {
    expect(spokenLanguage('app', 'tr')).toBe('tr');
    expect(spokenLanguage('en', 'tr')).toBe('en');
    expect(spokenLanguage('auto', 'tr')).toBeUndefined();
  });
});
