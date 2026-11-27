import { describe, expect, it } from 'vitest';
import { linkInArgs, parseLink } from './links';

describe('parseLink', () => {
  it('reads the chats a link can name', () => {
    expect(parseLink('leafbot://thread/abc_12')).toEqual({ kind: 'thread', id: 'abc_12' });
    expect(parseLink('leafbot://bot/b1/')).toEqual({ kind: 'bot', id: 'b1' });
    expect(parseLink('leafbot:room/r-9')).toEqual({ kind: 'room', id: 'r-9' });
  });

  it("reads the link a saved app's launcher opens", () => {
    expect(parseLink('leafbot://app/Xy_9-a')).toEqual({ kind: 'app', id: 'Xy_9-a' });
    expect(linkInArgs(['C:\\Leaf Bot\\Leaf Bot.exe', 'leafbot://app/a1'])).toEqual({ kind: 'app', id: 'a1' });
    expect(parseLink('leafbot://app/a%20b')).toBeNull();
  });

  it('opens links made before the rename', () => {
    expect(parseLink('yumakbot://thread/abc_12')).toEqual({ kind: 'thread', id: 'abc_12' });
    expect(linkInArgs(['/opt/Leaf Bot/leafbot', 'yumakbot://bot/b1'])).toEqual({ kind: 'bot', id: 'b1' });
  });

  it('refuses anything else', () => {
    for (const bad of [
      'https://thread/abc',
      'leafbot://settings/x',
      'leafbot://thread/',
      'leafbot://thread/a/b',
      'leafbot://thread/..%2F..',
      'not a url',
    ]) {
      expect(parseLink(bad)).toBeNull();
    }
  });

  it('finds the link among the arguments a second start gets', () => {
    expect(linkInArgs(['/opt/Leaf Bot/leafbot', '--no-sandbox', 'leafbot://bot/b1'])).toEqual({
      kind: 'bot',
      id: 'b1',
    });
    expect(linkInArgs(['/opt/Leaf Bot/leafbot'])).toBeNull();
  });
});
