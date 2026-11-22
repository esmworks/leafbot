import { describe, expect, it } from 'vitest';
import { inOrder } from './in-order';

const later = <T>(value: T, ms: number) => new Promise<T>((done) => setTimeout(() => done(value), ms));

describe('inOrder', () => {
  it('sends pieces of one key in the order they were asked, however long each lookup takes', async () => {
    const run = inOrder(() => {});
    const sent: string[] = [];
    await Promise.all([
      run(
        't1',
        () => later('Vezir', 30),
        (v) => sent.push(v),
      ),
      run(
        't1',
        () => later("'e haber", 5),
        (v) => sent.push(v),
      ),
      run(
        't1',
        () => Promise.resolve(' verdim.'),
        (v) => sent.push(v),
      ),
    ]);
    expect(sent.join('')).toBe("Vezir'e haber verdim.");
  });

  it('starts every lookup at once instead of one after another', async () => {
    const run = inOrder(() => {});
    const started: number[] = [];
    const t0 = Date.now();
    await Promise.all(
      [1, 2, 3].map((n) =>
        run(
          't1',
          () => {
            started.push(Date.now() - t0);
            return later(n, 20);
          },
          () => {},
        ),
      ),
    );
    expect(Math.max(...started)).toBeLessThan(15);
  });

  it('does not hold one key behind another', async () => {
    const run = inOrder(() => {});
    const sent: string[] = [];
    await Promise.all([
      run(
        'slow',
        () => later('slow', 30),
        (v) => sent.push(v),
      ),
      run(
        'quick',
        () => later('quick', 1),
        (v) => sent.push(v),
      ),
    ]);
    expect(sent).toEqual(['quick', 'slow']);
  });

  it('reports a failed piece and still sends the ones after it', async () => {
    const errors: unknown[] = [];
    const run = inOrder((err) => errors.push(err));
    const sent: string[] = [];
    await Promise.all([
      run(
        't1',
        () => Promise.reject(new Error('lookup failed')),
        (v: string) => sent.push(v),
      ),
      run(
        't1',
        () => Promise.resolve('next'),
        (v) => sent.push(v),
      ),
    ]);
    expect(sent).toEqual(['next']);
    expect(errors).toHaveLength(1);
  });
});
