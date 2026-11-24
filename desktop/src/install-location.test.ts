import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readMoveDeclined, runsFromTransientPlace, writeMoveDeclined } from './install-location';

const bin = '/Leaf Bot.app/Contents/MacOS/Leaf Bot';

describe('uygulamanın çalıştığı yer', () => {
  it('disk görüntüsünden ya da taşınmış (translocated) kopyadan çalışmayı tanır', () => {
    expect(runsFromTransientPlace('darwin', `/Volumes/Leaf Bot${bin}`, false)).toBe(true);
    expect(
      runsFromTransientPlace('darwin', `/private/var/folders/ab/cd/T/AppTranslocation/X/d${bin}`, false),
    ).toBe(true);
  });

  it('Uygulamalar klasöründekine, kendi klasöründekine ve macOS dışına dokunmaz', () => {
    expect(runsFromTransientPlace('darwin', `/Applications${bin}`, true)).toBe(false);
    expect(runsFromTransientPlace('darwin', `/Users/a/Downloads${bin}`, false)).toBe(false);
    expect(runsFromTransientPlace('win32', `/Volumes/x${bin}`, false)).toBe(false);
  });

  it('"şimdi değil" cevabını hatırlar', () => {
    const dir = mkdtempSync(join(tmpdir(), 'leafbot-move-'));
    expect(readMoveDeclined(dir)).toBe(false);
    writeMoveDeclined(dir, true);
    expect(readMoveDeclined(dir)).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});
