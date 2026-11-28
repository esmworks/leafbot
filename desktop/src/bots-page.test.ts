import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BOTS_ORIGIN, botsFile, botsPolicy, botsUrl, pageOrigin } from './bots-page';

const DIR = '/app/bots';

describe('hesap sunucuları sayfası', () => {
  it('adres seçilen sunucuyu söyler', () => {
    expect(botsUrl(null)).toBe('leafbot-app://bots/bots/');
    expect(botsUrl('s&1')).toBe('leafbot-app://bots/bots/?server=s%261');
  });

  it('dosyaları klasörün içinden verir, sayfa yollarında index.html döner', () => {
    expect(botsFile(DIR, 'leafbot-app://bots/bots/')).toBe(join(DIR, 'index.html'));
    expect(botsFile(DIR, 'leafbot-app://bots/bots/?server=x')).toBe(join(DIR, 'index.html'));
    expect(botsFile(DIR, 'leafbot-app://bots/bots/assets/a.js')).toBe(join(DIR, 'assets/a.js'));
  });

  it('klasörün dışına ve başka adreslere çıkmaz', () => {
    expect(botsFile(DIR, 'leafbot-app://bots/bots/..%2F..%2Fetc%2Fpasswd.txt')).toBeNull();
    expect(botsFile(DIR, 'leafbot-app://bots/bots/%2e%2e/secret.js')).toBeNull();
    expect(botsFile(DIR, 'leafbot-app://bots/other/a.js')).toBeNull();
    expect(botsFile(DIR, 'leafbot-app://evil/bots/a.js')).toBeNull();
    expect(botsFile(DIR, 'https://bots/bots/a.js')).toBeNull();
  });

  it('origin bütün olarak karşılaştırılır; bilinmeyen şemaların origini yoktur', () => {
    expect(pageOrigin('leafbot-app://bots/bots/?server=1')).toBe(BOTS_ORIGIN);
    expect(pageOrigin('leafbot-app://other/bots/')).toBeNull();
    expect(pageOrigin('http://127.0.0.1:4319/x')).toBe('http://127.0.0.1:4319');
    expect(pageOrigin('file:///etc/passwd')).toBeNull();
    expect(pageOrigin('leafbot://thread/1')).toBeNull();
    expect(pageOrigin('javascript:alert(1)')).toBeNull();
  });

  it('güvenlik politikası yalnızca uygulamanın dosyalarına ve aktarıcıya izin verir', () => {
    const p = botsPolicy('wss://signal.leafbot.app/v1/signal');
    expect(p).toContain("script-src 'self'");
    expect(p).toContain("connect-src 'self' wss://signal.leafbot.app;");
    expect(p).toContain("frame-src 'none'");
    expect(p).not.toContain('unsafe-eval');
  });
});
