import * as ExpoCrypto from 'expo-crypto';

/**
 * What the tunnel code reads from the runtime and Hermes may lack, filled in before that code runs
 * (the root layout imports this first): `crypto.getRandomValues` from the system's random source,
 * and, only if missing, `atob`, `btoa`, `TextEncoder` and `TextDecoder`. WebRTC itself is not put
 * on the globals: the tunnel is given react-native-webrtc's classes directly (see tunnelOpen.ts).
 */
const g = globalThis as Record<string, unknown>;

if (typeof (g.crypto as { getRandomValues?: unknown } | undefined)?.getRandomValues !== 'function') {
  const getRandomValues = <T extends ArrayBufferView | null>(array: T): T => {
    if (array) ExpoCrypto.getRandomValues(array as unknown as Uint8Array);
    return array;
  };
  // `crypto` may exist without the function (a partial one), so it is defined with it rather than assigned over.
  Object.defineProperty(g, 'crypto', {
    value: { ...((g.crypto as object | undefined) ?? {}), getRandomValues },
    configurable: true,
    writable: true,
  });
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

if (typeof g.btoa !== 'function') {
  g.btoa = (bin: string): string => {
    let out = '';
    for (let i = 0; i < bin.length; i += 3) {
      const a = bin.charCodeAt(i);
      const b = bin.charCodeAt(i + 1);
      const c = bin.charCodeAt(i + 2);
      out += B64[a >> 2]! + B64[((a & 3) << 4) | ((b || 0) >> 4)]!;
      out += Number.isNaN(b) ? '=' : B64[((b & 15) << 2) | ((c || 0) >> 6)]!;
      out += Number.isNaN(c) ? '=' : B64[c & 63]!;
    }
    return out;
  };
}

if (typeof g.atob !== 'function') {
  g.atob = (text: string): string => {
    const clean = text.replace(/[^A-Za-z0-9+/]/g, '');
    let out = '';
    let bits = 0;
    let acc = 0;
    for (const ch of clean) {
      acc = (acc << 6) | B64.indexOf(ch);
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        out += String.fromCharCode((acc >> bits) & 255);
      }
    }
    return out;
  };
}

if (typeof g.TextEncoder !== 'function') {
  g.TextEncoder = class {
    readonly encoding = 'utf-8';
    encode(input = ''): Uint8Array {
      const bytes: number[] = [];
      for (const ch of input) {
        const cp = ch.codePointAt(0)!;
        if (cp < 0x80) bytes.push(cp);
        else if (cp < 0x800) bytes.push(0xc0 | (cp >> 6), 0x80 | (cp & 63));
        else if (cp < 0x10000) bytes.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
        else
          bytes.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
      }
      return new Uint8Array(bytes);
    }
  };
}

if (typeof g.TextDecoder !== 'function') {
  g.TextDecoder = class {
    readonly encoding = 'utf-8';
    decode(input?: ArrayBuffer | ArrayBufferView): string {
      if (!input) return '';
      const b =
        input instanceof ArrayBuffer
          ? new Uint8Array(input)
          : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
      let out = '';
      for (let i = 0; i < b.length;) {
        const c = b[i++]!;
        let cp = 0xfffd;
        const more = c >= 0xf0 ? 3 : c >= 0xe0 ? 2 : c >= 0xc0 ? 1 : 0;
        if (c < 0x80) cp = c;
        else if (c >= 0xc0 && c < 0xf8 && i + more <= b.length) {
          cp = c & (0x3f >> more);
          for (let k = 0; k < more; k++) cp = (cp << 6) | (b[i++]! & 63);
        }
        out += String.fromCodePoint(cp > 0x10ffff ? 0xfffd : cp);
      }
      return out;
    }
  };
}
