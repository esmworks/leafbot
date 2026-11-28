import { describe, expect, it, vi } from 'vitest';
import { ticketsAhead } from './ticketsAhead';

describe('ticketsAhead', () => {
  it('asks for the relay and proof tickets at once, and a fresh one after', async () => {
    let n = 0;
    const fetch = vi.fn(async () => `t${++n}`);
    const ticket = ticketsAhead(fetch);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(await ticket()).toBe('t1');
    expect(await ticket()).toBe('t2');
    expect(await ticket()).toBe('t3');
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('asks again for a proof ticket that grew old waiting', async () => {
    let n = 0;
    let clock = 0;
    const ticket = ticketsAhead(
      async () => `t${++n}`,
      () => clock,
    );
    await ticket();
    clock = 31_000;
    expect(await ticket()).toBe('t3');
  });

  it('asks again when the one asked ahead failed', async () => {
    let n = 0;
    const ticket = ticketsAhead(async () => {
      n++;
      if (n === 2) throw new Error('busy');
      return `t${n}`;
    });
    await ticket();
    expect(await ticket()).toBe('t3');
  });

  it('lets the relay see a failure of its own ticket', async () => {
    const ticket = ticketsAhead(() => Promise.reject(new Error('down')));
    await expect(ticket()).rejects.toThrow('down');
  });
});
