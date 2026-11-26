import nodeDataChannel from 'node-datachannel';
import { describe, expect, it } from 'vitest';
import type { TunnelChannel } from '../src/tunnel/gateway';
import { iceServersFor, loadRtc } from '../src/tunnel/rtc-datachannel';

describe('the server side of WebRTC', () => {
  it('reads the relay’s ICE servers', () => {
    expect(
      iceServersFor([
        { urls: ['stun:turn.example:3478'] },
        {
          urls: [
            'turn:turn.example:3478?transport=udp',
            'turn:turn.example:3478?transport=tcp',
            'turns:turn.example:5349',
          ],
          username: 'u',
          credential: 'p',
        },
        { urls: ['turn:no-credentials.example'] },
      ]),
    ).toEqual([
      'stun:turn.example:3478',
      { hostname: 'turn.example', port: 3478, username: 'u', password: 'p', relayType: 'TurnUdp' },
      { hostname: 'turn.example', port: 3478, username: 'u', password: 'p', relayType: 'TurnTcp' },
      { hostname: 'turn.example', port: 5349, username: 'u', password: 'p', relayType: 'TurnTls' },
    ]);
  });

  it('answers an offer, connects on this machine and carries channels both ways', async () => {
    const rtc = await loadRtc();
    expect(rtc).not.toBeNull();
    const server = rtc!({ iceServers: [] });
    // The browser's side, played by the same library.
    const browser = new nodeDataChannel.PeerConnection('browser', { iceServers: [] });
    const toServer: { candidate: string; mid: string }[] = [];
    let serverReady = false;
    browser.onLocalCandidate((candidate, mid) => {
      if (serverReady) server.addCandidate({ candidate, sdpMid: mid });
      else toServer.push({ candidate, mid });
    });
    server.onCandidate((c) => {
      if (c) browser.addRemoteCandidate(c.candidate, c.sdpMid ?? '0');
    });
    const offer = new Promise<string>((r) =>
      browser.onLocalDescription((sdp, type) => type === 'offer' && r(sdp)),
    );
    const ctl = browser.createDataChannel('ctl');
    const answer = await server.answer(await offer);
    serverReady = true;
    for (const c of toServer) server.addCandidate({ candidate: c.candidate, sdpMid: c.mid });
    browser.setRemoteDescription(answer, 'answer');

    const connected = new Promise<void>((r) => server.onConnected(r));
    const got = new Promise<TunnelChannel>((r) => server.onChannel(r));
    await connected;
    const ch = await got;
    expect(ch.label).toBe('ctl');
    // Each side names the other's certificate as the other's description does.
    expect(server.remoteFingerprint).toMatch(/^sha-256 [0-9A-F:]+$/);
    expect(server.localFingerprint).toMatch(/^sha-256 [0-9A-F:]+$/);
    expect(server.localFingerprint).toBe(/^a=fingerprint:(\S+ \S+)/m.exec(answer)![1]);

    const fromServer = new Promise<string | Buffer | ArrayBuffer>((r) => ctl.onMessage(r));
    const atServer = new Promise<string | Uint8Array>((r) => ch.onMessage(r));
    ctl.sendMessageBinary(new Uint8Array([1, 2, 3]));
    expect(Array.from((await atServer) as Uint8Array)).toEqual([1, 2, 3]);
    ch.send('hello');
    expect(await fromServer).toBe('hello');

    const closed = new Promise<void>((r) => server.onClose(r));
    browser.close();
    server.close();
    await closed;
  }, 20_000);
});
