import type { Message } from './schemas.js';
import { describe, expect, it } from 'vitest';
import { CHAT_PAGE, FULL_PAGE, keepEarlier, refreshLimit, withOlder } from './message-pages';

const msg = (id: string): Message => ({
  id,
  threadId: 't1',
  role: 'user',
  author: 'user',
  text: id,
  props: {},
  clientId: null,
  turnId: null,
  createdAt: '2026-11-27T00:00:00.000Z',
});
const list = (...ids: string[]) => ids.map(msg);
const ids = (messages: Message[]) => messages.map((m) => m.id);

describe('sohbet sayfaları', () => {
  it('yeni mesaj en eskisini okunan sayfadan itince o mesaj ekranda kalır', () => {
    expect(ids(keepEarlier(list('m1', 'm2', 'm3'), list('m2', 'm3', 'm4')))).toEqual([
      'm1',
      'm2',
      'm3',
      'm4',
    ]);
  });

  it('yukarıda yüklenmiş eski sayfalarla sohbetin arasında boşluk kalmaz', () => {
    const held = list('o1', 'o2', 'm1', 'm2', 'm3');
    expect(ids(keepEarlier(held, list('m3', 'm4', 'm5')))).toEqual([
      'o1',
      'o2',
      'm1',
      'm2',
      'm3',
      'm4',
      'm5',
    ]);
  });

  it('okunan sayfadaki silinen mesaj ekrandan kalkar', () => {
    expect(ids(keepEarlier(list('m1', 'm2', 'm3'), list('m0', 'm1', 'm3')))).toEqual(['m0', 'm1', 'm3']);
  });

  it('ekrandakiyle ortak mesajı olmayan okuma ekrandakinin yerine geçer', () => {
    expect(ids(keepEarlier(list('m1', 'm2'), list('n1', 'n2')))).toEqual(['n1', 'n2']);
  });

  it('boş sohbet ya da ilk okuma olduğu gibi kalır', () => {
    expect(ids(keepEarlier([], list('m1')))).toEqual(['m1']);
    expect(keepEarlier(list('m1'), [])).toEqual([]);
  });

  it('eski sayfa ekrandakilerin üstüne, ikinci kez gelmeden eklenir', () => {
    expect(ids(withOlder(list('o1', 'o2', 'm1'), list('m1', 'm2')))).toEqual(['o1', 'o2', 'm1', 'm2']);
  });

  it('yeniden okuma ekrandakilerin hepsini kapsar ama sunucunun sayfasını aşmaz', () => {
    expect(refreshLimit(0)).toBe(CHAT_PAGE);
    expect(refreshLimit(120)).toBe(120);
    expect(refreshLimit(2000)).toBe(FULL_PAGE);
  });
});
