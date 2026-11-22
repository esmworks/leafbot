import { describe, expect, it } from 'vitest';
import { runCommand } from './RoutinePage';

describe('rutin çalıştırma komutu', () => {
  it('anahtarı ortamdan okur, komuta yazmaz', () => {
    const cmd = runCommand('https://leafbot.example', 'r1');
    expect(cmd).toContain("curl -X POST 'https://leafbot.example/api/routines/r1/run'");
    expect(cmd).toContain('Bearer $LEAFBOT_ACCESS_KEY');
    expect(cmd.split('\n')).toHaveLength(4);
  });
});
