import type { IceServer } from '@leafbot/shared/signal';
import type * as NodeDataChannel from 'node-datachannel';
import { BUFFER_LOW } from '@leafbot/shared/tunnel';
import type { TunnelChannel } from './gateway';
import type { Candidate, RtcConnection, RtcFactory } from './signal';

/**
 * The server's WebRTC connections, made with node-datachannel (libdatachannel). All of it lives in
 * this file, behind `RtcFactory`, so another library would replace only this file. It ships a build
 * for each platform the server runs on (macOS, Windows and Linux on x64 and arm64), as N-API, so one
 * build serves both Node and the desktop app's Electron.
 */

type Ndc = typeof NodeDataChannel;
type PeerConnection = InstanceType<Ndc['PeerConnection']>;
type DataChannel = Parameters<Parameters<PeerConnection['onDataChannel']>[0]>[0];
type NdcIceServer = Exclude<ConstructorParameters<Ndc['PeerConnection']>[1]['iceServers'][number], string>;

/** The relay's ICE servers (`stun:`, `turn:`, `turns:` URLs) as node-datachannel takes them. */
export function iceServersFor(servers: IceServer[]): (string | NdcIceServer)[] {
  const out: (string | NdcIceServer)[] = [];
  for (const s of servers) {
    for (const url of s.urls) {
      const m = /^(stuns?|turns?):([^?]+?)(?::(\d+))?(?:\?transport=(udp|tcp))?$/i.exec(url.trim());
      if (!m) continue;
      const scheme = m[1]!.toLowerCase();
      const host = m[2]!.replace(/^\[|\]$/g, '');
      const tls = scheme.endsWith('s');
      const port = Number(m[3] ?? (tls ? 5349 : 3478));
      if (scheme.startsWith('stun')) {
        out.push(`stun:${host.includes(':') ? `[${host}]` : host}:${port}`);
        continue;
      }
      if (!s.username || !s.credential) continue;
      out.push({
        hostname: host,
        port,
        username: s.username,
        password: s.credential,
        relayType: tls ? 'TurnTls' : m[4]?.toLowerCase() === 'tcp' ? 'TurnTcp' : 'TurnUdp',
      });
    }
  }
  return out;
}

/** The DTLS fingerprint an SDP names (`a=fingerprint:sha-256 AB:...`). */
function sdpFingerprint(sdp: string | undefined): string {
  const m = /^a=fingerprint:(\S+ [0-9A-Fa-f:]+)\s*$/m.exec(sdp ?? '');
  if (!m) throw new Error('no DTLS fingerprint in the description');
  return m[1]!;
}

/**
 * Holds what arrives before anyone listens: channels open and messages come as soon as DTLS is up,
 * a moment before the gateway takes the connection.
 */
class Inbox<T> {
  private queue: T[] = [];
  private cb: ((v: T) => void) | null = null;
  push(v: T) {
    if (this.cb) this.cb(v);
    else this.queue.push(v);
  }
  listen(cb: (v: T) => void) {
    this.cb = cb;
    for (const v of this.queue.splice(0)) cb(v);
  }
}

function channel(dc: DataChannel): TunnelChannel {
  const messages = new Inbox<string | Uint8Array>();
  const closed = new Inbox<void>();
  let drain: (() => void) | null = null;
  let over = false;
  const end = () => {
    if (over) return;
    over = true;
    closed.push();
  };
  dc.setBufferedAmountLowThreshold(BUFFER_LOW);
  dc.onBufferedAmountLow(() => drain?.());
  dc.onMessage((msg) => {
    if (typeof msg === 'string') return messages.push(msg);
    messages.push(
      msg instanceof ArrayBuffer
        ? new Uint8Array(msg)
        : new Uint8Array(msg.buffer, msg.byteOffset, msg.byteLength),
    );
  });
  dc.onClosed(end);
  dc.onError(end);
  return {
    label: dc.getLabel(),
    get bufferedAmount() {
      return over ? 0 : dc.bufferedAmount();
    },
    send(data) {
      if (over) return;
      try {
        if (typeof data === 'string') dc.sendMessage(data);
        else dc.sendMessageBinary(data);
      } catch {
        // The channel closed under the send; its close follows.
      }
    },
    close() {
      if (over) return;
      try {
        dc.close();
      } catch {
        // Already closed.
      }
      end();
    },
    onMessage: (cb) => messages.listen(cb),
    onClose: (cb) => closed.listen(cb),
    onDrain(cb) {
      drain = cb;
    },
  };
}

function connection(ndc: Ndc, iceServers: IceServer[]): RtcConnection {
  const pc: PeerConnection = new ndc.PeerConnection('leafbot', {
    iceServers: iceServersFor(iceServers),
    // Large enough for the tunnel's frames; browsers accept 256 KiB.
    maxMessageSize: 256 * 1024,
  });
  const channels = new Inbox<TunnelChannel>();
  const closed = new Inbox<void>();
  let candidateCb: ((c: Candidate) => void) | null = null;
  let connectedCb: (() => void) | null = null;
  let answered: ((sdp: string) => void) | null = null;
  let haveOffer = false;
  const early: NonNullable<Candidate>[] = [];
  let over = false;
  let local = '';
  let remote = '';

  const end = () => {
    if (over) return;
    over = true;
    closed.push();
  };
  pc.onLocalDescription((sdp, type) => {
    if (type !== 'answer') return;
    local = sdp;
    answered?.(sdp);
    answered = null;
  });
  pc.onLocalCandidate((candidate, mid) => candidateCb?.({ candidate, sdpMid: mid }));
  pc.onGatheringStateChange((state) => {
    if (state === 'complete') candidateCb?.(null);
  });
  pc.onStateChange((state) => {
    if (state === 'connected') connectedCb?.();
    else if (state === 'failed' || state === 'closed') end();
  });
  pc.onDataChannel((dc) => channels.push(channel(dc)));

  const add = (c: NonNullable<Candidate>) => {
    try {
      pc.addRemoteCandidate(c.candidate, c.sdpMid ?? '0');
    } catch {
      // A candidate this side cannot use; the others still can.
    }
  };

  return {
    get localFingerprint() {
      return sdpFingerprint(local);
    },
    get remoteFingerprint() {
      return sdpFingerprint(remote);
    },
    answer(offerSdp) {
      return new Promise<string>((resolve, reject) => {
        if (over) return reject(new Error('closed'));
        answered = resolve;
        try {
          remote = offerSdp;
          pc.setRemoteDescription(offerSdp, 'offer');
          haveOffer = true;
          for (const c of early.splice(0)) add(c);
        } catch (err) {
          answered = null;
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
    },
    addCandidate(c) {
      // The end of the browser's candidates, or an empty one, needs nothing here.
      if (!c?.candidate) return;
      if (haveOffer) add(c);
      else early.push(c);
    },
    onCandidate(cb) {
      candidateCb = cb;
    },
    onConnected(cb) {
      connectedCb = cb;
    },
    onChannel: (cb) => channels.listen(cb),
    onClose: (cb) => closed.listen(cb),
    close() {
      if (over) return;
      try {
        pc.close();
      } catch {
        // Already closed.
      }
      end();
    },
  };
}

/**
 * Loads node-datachannel and returns the factory, or null when this install has no build of it for
 * this platform: the server then runs as before, only without browsers reaching it through the
 * account.
 */
export async function loadRtc(): Promise<RtcFactory | null> {
  try {
    const mod = (await import('node-datachannel')) as Ndc & { default?: Ndc };
    const ndc = mod.PeerConnection ? mod : (mod.default as Ndc);
    return ({ iceServers }) => connection(ndc, iceServers);
  } catch {
    return null;
  }
}
