import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { grokBotNames, grokChatLines, readGrokChat, sliceKey } from './grok-chat';

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';
/** A cache file name the way the app writes it: the key in unpadded lowercase base32. */
function fileName(key: string): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of Buffer.from(key, 'utf8')) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return `${out}.blob`;
}

const ACCOUNT = 'sand.client.slice.account.user%2E1';

describe('Grok Bot chat cache', () => {
  let home: string;
  let folder: string;
  const slice = (kind: string, value: unknown) =>
    writeFileSync(join(folder, fileName(`${ACCOUNT}.${kind}`)), JSON.stringify({ schemaVersion: 1, value }));

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'leafbot-home-'));
    folder = join(home, 'Library', 'Application Support', 'Grok Bot', 'sand-client-persistence');
    mkdirSync(folder, { recursive: true });
    // Sign-in material beside the cache, which is never to be read.
    writeFileSync(join(home, 'Library', 'Application Support', 'Grok Bot', 'sand-secrets.json'), '{"t":"x"}');
    slice('roster.last-roster', {
      rows: [
        { id: 'b1', name: 'Trip Planner' },
        { id: 'b2', name: 'Twin' },
        { id: 'b3', name: 'twin' },
        { id: 'g1', name: 'Household', isGroup: true },
        { id: 'b4', name: 'Quiet' },
      ],
    });
    slice('transcript.replicas.b1', {
      entries: [
        { kind: 'message', role: 'user', content: 'Plan Rome', seq: 2, timestampMs: 2000 },
        {
          kind: 'send-message',
          message: { type: 'text', content: 'Which dates?' },
          seq: 3,
          timestampMs: 3000,
        },
        { kind: 'message', role: 'user', content: 'Plan Rome', seq: 2, timestampMs: 2000 },
        {
          kind: 'send-message',
          message: {
            type: 'widget',
            widget: {
              prompt: 'Train or plane?',
              options: [
                { label: 'Train', value: 't' },
                { label: 'Plane', value: 'p' },
              ],
            },
          },
          respondedValue: 't',
          seq: 4,
          timestampMs: 4000,
        },
        { kind: 'user-attachment', file_name: 'tickets.pdf', seq: 5, timestampMs: 5000 },
        { kind: 'event', event: { type: 'automation-changed' }, seq: 6, timestampMs: 6000 },
        {
          kind: 'send-message',
          message: { type: 'text', content: `Key ghp_${'a1B2'.repeat(9)}` },
          seq: 7,
          timestampMs: 7000,
        },
        { kind: 'message', role: 'system', content: 'hidden', seq: 8, timestampMs: 8000 },
        { kind: 'message', role: 'user', content: 'no time', seq: 9 },
      ],
    });
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it('decodes the cache file names', () => {
    expect(sliceKey(fileName('roster.last-roster'))).toBe('roster.last-roster');
    expect(sliceKey('not-base32!.blob')).toBeNull();
    expect(sliceKey('x.json')).toBeNull();
  });

  it('lists the bots, not the group chats', () => {
    expect(grokBotNames(home)).toEqual(['Trip Planner', 'Twin', 'twin', 'Quiet']);
  });

  it('reads one bot’s chat in order, once each, with the answer to a question and keys masked', () => {
    const chat = readGrokChat(home, ' trip planner ');
    expect('lines' in chat && chat.lines.map((l) => [l.role, l.text])).toEqual([
      ['user', 'Plan Rome'],
      ['assistant', 'Which dates?'],
      ['assistant', 'Train or plane?\n- Train\n- Plane'],
      ['user', 'Train'],
      ['user', 'tickets.pdf'],
      ['assistant', 'Key [key]'],
    ]);
  });

  it('says why no chat came over', () => {
    expect(readGrokChat(home, 'Twin')).toEqual({ reason: 'ambiguous' });
    expect(readGrokChat(home, 'Nobody')).toEqual({ reason: 'noMatch' });
    expect(readGrokChat(home, 'Quiet')).toEqual({ reason: 'empty' });
    expect(readGrokChat(join(home, 'elsewhere'), 'Trip Planner')).toEqual({ reason: 'noApp' });
    expect(grokBotNames(join(home, 'elsewhere'))).toBeNull();
  });

  it('names the bot that wrote a message in a team chat', () => {
    const lines = grokChatLines([
      {
        kind: 'message',
        role: 'assistant',
        content: 'Done',
        fromAgent: { name: 'Bookkeeper' },
        seq: 1,
        timestampMs: 1,
      },
    ]);
    expect(lines[0]!.text).toBe('Bookkeeper:\nDone');
  });

  it('skips a cache file over 32 MiB', () => {
    const big = JSON.stringify({
      schemaVersion: 1,
      value: { rows: [{ id: 'b9', name: 'Big' }], pad: 'x'.repeat(33 * 1024 * 1024) },
    });
    writeFileSync(join(folder, fileName(`${ACCOUNT}.roster.last-roster`)), big);
    expect(grokBotNames(home)).toEqual([]);
  });

  it('does not follow a symlink for the cache folder or a cache file', () => {
    const real = join(home, 'real-cache');
    mkdirSync(real);
    const other = mkdtempSync(join(tmpdir(), 'leafbot-home-'));
    try {
      mkdirSync(join(other, '.config', 'Grok Bot'), { recursive: true });
      symlinkSync(real, join(other, '.config', 'Grok Bot', 'sand-client-persistence'));
      expect(grokBotNames(other)).toBeNull();

      const target = join(home, 'elsewhere.json');
      writeFileSync(
        target,
        JSON.stringify({ schemaVersion: 1, value: { rows: [{ id: 'b9', name: 'Linked' }] } }),
      );
      const name = fileName(`${ACCOUNT}.roster.last-roster`);
      rmSync(join(folder, name));
      symlinkSync(target, join(folder, name));
      expect(grokBotNames(home)).toEqual([]);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });
});
