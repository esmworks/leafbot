import { BUFFER_LOW, CHANNEL } from '@leafbot/shared/tunnel';
import {
  SIGNAL_MAX_MESSAGE_BYTES,
  SignalClose,
  SignalOutbound,
  type IceServer,
  type SignalInbound,
} from '@leafbot/shared/signal';
import type { Channel, Peer } from './channel';

/** Why a connection to a server could not be set up. */
export type ConnectFailure = 'offline' | 'relay' | 'ticket' | 'revoked' | 'busy' | 'failed' | 'timeout';

export class ConnectError extends Error {
  /**
   * `detail`: the step that failed and what the WebRTC stack said, when it said something. Not for
   * deciding anything; it lets a screen show what went wrong on a device nobody can debug.
   */
  constructor(
    readonly code: ConnectFailure,
    readonly detail?: string,
  ) {
    super(detail ? `${code}: ${detail}` : code);
  }
}

/** What an error says, short enough to show on a screen. */
function said(err: unknown): string {
  const text = err instanceof Error ? err.message || err.name : String(err);
  return text.slice(0, 200);
}

/**
 * A candidate from the server as every WebRTC stack takes it. The server's (libdatachannel) come as
 * SDP lines, `a=candidate:…`, with the media section named only by `sdpMid`; the standard form is
 * `candidate:…`, and some stacks also want the section's index. The tunnel has one media section.
 */
export function remoteCandidate(c: {
  candidate: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
  usernameFragment?: string | null;
}): RTCIceCandidateInit {
  return {
    candidate: c.candidate.trim().replace(/^a=/, ''),
    sdpMid: c.sdpMid ?? '0',
    sdpMLineIndex: c.sdpMLineIndex ?? 0,
    ...(c.usernameFragment ? { usernameFragment: c.usernameFragment } : {}),
  };
}

/** The DTLS fingerprint an SDP names (`a=fingerprint:sha-256 AB:...`). */
export function sdpFingerprint(sdp: string | undefined): string {
  const m = /^a=fingerprint:(\S+ [0-9A-Fa-f:]+)\s*$/m.exec(sdp ?? '');
  if (!m) throw new ConnectError('failed');
  return m[1]!;
}

/** One `RTCDataChannel` as a `Channel`; resolves once it is open. */
export function dataChannel(dc: RTCDataChannel): Promise<Channel> {
  dc.binaryType = 'arraybuffer';
  dc.bufferedAmountLowThreshold = BUFFER_LOW;
  const ch: Channel = {
    label: dc.label,
    get bufferedAmount() {
      return dc.bufferedAmount;
    },
    send: (d) => {
      if (typeof d === 'string') dc.send(d);
      else dc.send(d as Uint8Array<ArrayBuffer>);
    },
    close: () => dc.close(),
    onMessage: (cb) =>
      dc.addEventListener('message', (e: MessageEvent<string | ArrayBuffer>) =>
        cb(typeof e.data === 'string' ? e.data : new Uint8Array(e.data)),
      ),
    onClose: (cb) => dc.addEventListener('close', () => cb()),
    onDrain: (cb) => dc.addEventListener('bufferedamountlow', () => cb()),
  };
  if (dc.readyState === 'open') return Promise.resolve(ch);
  return new Promise<Channel>((resolve, reject) => {
    dc.addEventListener('open', () => resolve(ch), { once: true });
    dc.addEventListener('close', () => reject(new ConnectError('failed')), { once: true });
  });
}

function closeFailure(code: number): ConnectFailure {
  switch (code) {
    case SignalClose.hostOffline:
      return 'offline';
    case SignalClose.ticketInvalid:
    case SignalClose.ticketReplayed:
      return 'ticket';
    case SignalClose.revoked:
      return 'revoked';
    case SignalClose.busy:
    case SignalClose.rateLimited:
      return 'busy';
    default:
      return 'relay';
  }
}

export interface ConnectOptions {
  /** The relay's signalling address, `wss://…/v1/signal`. */
  relayUrl: string;
  /** A fresh client ticket for the server, for the relay's `hello`. */
  ticket(): Promise<string>;
  /** How long setting up may take, in ms. */
  timeoutMs?: number;
  /**
   * The WebRTC and WebSocket implementations; the globals by default. A runtime without them as
   * globals (Node, React Native before its globals are registered) passes its own.
   */
  rtc?: {
    RTCPeerConnection: typeof RTCPeerConnection;
    WebSocket: typeof WebSocket;
  };
}

/**
 * Sets up a WebRTC connection to a server through the relay: a `hello` with a ticket, the offer,
 * the answer and ICE candidates. The relay sees only this setup; once DTLS is up its socket closes
 * and app data flows between the browser and the server alone.
 */
export async function connectPeer(opts: ConnectOptions): Promise<Peer> {
  const ticket = await opts.ticket();
  const Rtc = opts.rtc?.RTCPeerConnection ?? globalThis.RTCPeerConnection;
  const Ws = opts.rtc?.WebSocket ?? globalThis.WebSocket;
  const ws = new Ws(opts.relayUrl);
  let pc: RTCPeerConnection | null = null;
  const timeoutMs = opts.timeoutMs ?? 40_000;

  try {
    return await new Promise<Peer>((resolve, reject) => {
      let settled = false;
      const fail = (code: ConnectFailure, detail?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new ConnectError(code, detail));
      };
      const timer = setTimeout(() => fail('timeout'), timeoutMs);
      const send = (msg: SignalInbound) => {
        if (ws.readyState === Ws.OPEN) ws.send(JSON.stringify(msg));
      };
      let ctl: RTCDataChannel | null = null;
      let offerSdp: string | null = null;
      const pendingCandidates: RTCIceCandidateInit[] = [];
      // Everything this side found, sent again with the offer when the server comes back.
      const ownCandidates: SignalInbound[] = [];

      const start = async (iceServers: IceServer[]) => {
        pc = new Rtc({ iceServers });
        const conn = pc;
        // The first channel must exist before the offer, or the offer carries no data section.
        ctl = conn.createDataChannel(CHANNEL.ctl, { ordered: true });
        conn.addEventListener('icecandidate', (e) => {
          const c = e.candidate;
          const msg: SignalInbound = {
            type: 'ice-candidate',
            candidate: c
              ? {
                  candidate: c.candidate,
                  sdpMid: c.sdpMid,
                  sdpMLineIndex: c.sdpMLineIndex,
                  usernameFragment: c.usernameFragment,
                }
              : null,
          };
          ownCandidates.push(msg);
          send(msg);
        });
        conn.addEventListener('connectionstatechange', () => {
          if (conn.connectionState === 'failed') fail('failed', `ice: ${conn.iceConnectionState}`);
        });
        const offer = await conn.createOffer();
        await conn.setLocalDescription(offer);
        offerSdp = conn.localDescription?.sdp ?? offer.sdp ?? null;
        if (!offerSdp) return fail('failed', 'offer: empty');
        send({ type: 'offer', sdp: offerSdp });
        const ctlChannel = ctl;
        dataChannel(ctlChannel).then(
          (first) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(peerOf(conn, first));
          },
          () => fail('failed', 'channel: closed before it opened'),
        );
      };

      ws.addEventListener('open', () => {
        send({ type: 'hello', role: 'client', ticket });
      });
      ws.addEventListener('close', (e) => fail(closeFailure(e.code)));
      ws.addEventListener('error', () => fail('relay'));
      ws.addEventListener('message', (e: MessageEvent<unknown>) => {
        if (typeof e.data !== 'string' || e.data.length > SIGNAL_MAX_MESSAGE_BYTES) return;
        let msg: SignalOutbound;
        try {
          msg = SignalOutbound.parse(JSON.parse(e.data));
        } catch {
          return;
        }
        switch (msg.type) {
          case 'welcome':
            if (!pc) void start(msg.iceServers).catch((e: unknown) => fail('failed', `start: ${said(e)}`));
            return;
          case 'host-online':
            // The relay dropped the offer and the candidates while the server was away (restarting, or
            // gone without the relay noticing yet); both go again. Without the candidates the server
            // knows no address of this browser, cannot let it through its TURN allocation, and the
            // connection fails only when ICE gives up.
            if (!offerSdp) return;
            send({ type: 'offer', sdp: offerSdp });
            for (const c of ownCandidates) send(c);
            return;
          case 'error':
            if (msg.code === 'host-offline') return; // The relay waits for it, up to its own limit.
            return fail('relay');
          case 'answer': {
            if (!pc) return;
            const conn = pc;
            void conn.setRemoteDescription({ type: 'answer', sdp: msg.sdp }).then(
              () => {
                // One candidate this phone or browser cannot use leaves the others to try.
                for (const c of pendingCandidates.splice(0)) void conn.addIceCandidate(c).catch(() => {});
              },
              (e: unknown) => fail('failed', `answer: ${said(e)}`),
            );
            return;
          }
          case 'ice-candidate': {
            if (!pc || !msg.candidate) return;
            const c = remoteCandidate(msg.candidate);
            if (pc.remoteDescription) void pc.addIceCandidate(c).catch(() => {});
            else pendingCandidates.push(c);
            return;
          }
          case 'ice-servers':
            pc?.setConfiguration({ iceServers: msg.iceServers });
            return;
          case 'bye':
            return fail('busy');
          default:
            return;
        }
      });
    });
  } catch (err) {
    (pc as RTCPeerConnection | null)?.close();
    throw err;
  } finally {
    // The relay is only for the setup; a live connection does not need it.
    ws.close();
  }
}

function peerOf(pc: RTCPeerConnection, ctl: Channel): Peer {
  let first: Channel | null = ctl;
  const closers: (() => void)[] = [];
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    pc.close();
    for (const cb of closers) cb();
  };
  pc.addEventListener('connectionstatechange', () => {
    if (pc.connectionState === 'failed' || pc.connectionState === 'closed') close();
  });
  return {
    localFingerprint: sdpFingerprint(pc.localDescription?.sdp),
    remoteFingerprint: sdpFingerprint(pc.remoteDescription?.sdp),
    open: (label) => {
      if (label === CHANNEL.ctl && first) {
        const ch = first;
        first = null;
        return Promise.resolve(ch);
      }
      if (closed) return Promise.reject(new ConnectError('failed'));
      return dataChannel(pc.createDataChannel(label, { ordered: true }));
    },
    onClose: (cb) => closers.push(cb),
    close,
  };
}
