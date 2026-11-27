import type { Bot, Group } from '@leafbot/shared';
import { describe, expect, it } from 'vitest';
import { UNGROUPED } from './botLayout';
import { othersIn, placeOf, placesFor, SHARED } from './places';

const bot = (over: Partial<Bot> = {}) => ({ id: 'b', pinned: false, groupId: null, ...over }) as Bot;
const folder = { id: 'klasor', ownerUserId: 'ben', memberIds: [] } as unknown as Group;
const open = { id: 'acik', ownerUserId: null, memberIds: ['ben', 'ayse'] } as unknown as Group;
const closed = { id: 'kapali', ownerUserId: null, memberIds: ['ayse'] } as unknown as Group;
const groups = [folder, open, closed];
const ids = (list: (Group | null)[] | null) => list?.map((g) => g?.id ?? null);

describe('botun yeri', () => {
  it('kendi botu Özel’de, başkasının alan dışındaki botu benimle paylaşılanlarda', () => {
    expect(placeOf(bot({ ownerUserId: 'ben' }), groups, 'ben')).toBe(UNGROUPED);
    expect(placeOf(bot({ ownerUserId: 'o' }), groups, 'ben')).toBe(SHARED);
    expect(placeOf(bot({ ownerUserId: 'o', groupId: 'gorulmeyen' }), groups, 'ben')).toBe(SHARED);
    expect(placeOf(bot({ ownerUserId: 'o', groupId: 'acik' }), groups, 'ben')).toBe('acik');
  });

  it('yeni bot yalnızca Özel’e ya da kendi klasörüne konur', () => {
    expect(ids(placesFor(undefined, groups, 'ben', true))).toEqual([null, 'klasor']);
  });

  it('kendi botunu üyesi olduğu alana, yönetici her alana taşır', () => {
    const mine = bot({ ownerUserId: 'ben' });
    expect(ids(placesFor(mine, groups, 'ben', false))).toEqual([null, 'klasor', 'acik']);
    expect(ids(placesFor(mine, groups, 'ben', true))).toEqual([null, 'klasor', 'acik', 'kapali']);
  });

  it('yönetici başkasının botunu yalnızca alandayken ve yalnızca alanlar arasında taşır', () => {
    expect(placesFor(bot({ ownerUserId: 'o' }), groups, 'ben', true)).toBeNull();
    expect(ids(placesFor(bot({ ownerUserId: 'o', groupId: 'kapali' }), groups, 'ben', true))).toEqual([
      'acik',
      'kapali',
    ]);
    expect(placesFor(bot({ ownerUserId: 'o', groupId: 'acik' }), groups, 'ben', false)).toBeNull();
  });

  it('alandaki sahibi dışındaki kişileri sayar; klasör kimseye açılmaz', () => {
    expect(othersIn(open, bot({ ownerUserId: 'ben' }))).toBe(1);
    expect(othersIn(folder, bot({ ownerUserId: 'ben' }))).toBe(0);
  });
});
