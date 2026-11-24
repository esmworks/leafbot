import type { Bot } from '@leafbot/shared';
import { describe, expect, it } from 'vitest';
import { applyMove, isNoop, moveTo, PINNED, sectionOf, UNGROUPED } from './botLayout';

let n = 0;
const bot = (name: string, extra: Partial<Bot> = {}): Bot => ({
  id: name,
  name,
  description: '',
  instructions: '',
  engine: 'claude',
  model: '',
  isManager: false,
  pinned: false,
  position: n,
  groupId: null,
  color: '#000000',
  avatar: 'object:circle',
  material: 'flat',
  permissionMode: 'ask',
  internet: true,
  projectDir: null,
  memory: true,
  effort: '',
  toolSelection: { only: false, allow: [], exclude: [] },
  archivedAt: null,
  createdAt: new Date(2026, 0, 1, 0, 0, n++).toISOString(),
  updatedAt: '',
  ...extra,
});

const order = (bots: Bot[], key: string) => bots.filter((b) => sectionOf(b) === key).map((b) => b.id);

describe('kenar çubuğunda taşıma', () => {
  const list = [
    bot('kahya', { pinned: true, isManager: true, position: 0 }),
    bot('ali', { groupId: 'g', position: 0 }),
    bot('veli', { groupId: 'g', position: 1 }),
    bot('can', { position: 0 }),
  ];

  it('bölüm içinde sırayı değiştirir', () => {
    expect(order(applyMove(list, 'veli', moveTo('g', 'ali')), 'g')).toEqual(['veli', 'ali']);
  });

  it('üste sabitlemek grubu korur; gruba taşımak sabitlemeyi kaldırır', () => {
    const pinned = applyMove(list, 'ali', moveTo(PINNED, null));
    expect(order(pinned, PINNED)).toEqual(['kahya', 'ali']);
    expect(pinned.find((b) => b.id === 'ali')!.groupId).toBe('g');
    const out = applyMove(list, 'kahya', moveTo(UNGROUPED, 'can'));
    expect(order(out, UNGROUPED)).toEqual(['kahya', 'can']);
    expect(out.find((b) => b.id === 'kahya')!.isManager).toBe(true);
  });

  it('yerinde bırakmayı ayırt eder', () => {
    expect(isNoop(list, 'ali', moveTo('g', 'veli'))).toBe(true);
    expect(isNoop(list, 'veli', moveTo('g', null))).toBe(true);
    expect(isNoop(list, 'ali', moveTo('g', null))).toBe(false);
    expect(isNoop(list, 'ali', moveTo(PINNED, null))).toBe(false);
  });
});
