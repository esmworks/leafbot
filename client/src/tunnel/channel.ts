/** One open data channel, whatever carries it: a browser `RTCDataChannel`, or a pair in tests. */
export interface Channel {
  readonly label: string;
  /** Bytes queued in the channel and not yet sent. */
  readonly bufferedAmount: number;
  send(data: string | Uint8Array): void;
  close(): void;
  onMessage(cb: (data: string | Uint8Array) => void): void;
  onClose(cb: () => void): void;
  /** Called when the queue has drained below `BUFFER_LOW`. */
  onDrain(cb: () => void): void;
}

/** The browser's end of one WebRTC connection to a server, once DTLS is up. */
export interface Peer {
  /** This browser's DTLS certificate fingerprint. */
  readonly localFingerprint: string;
  /** The server's DTLS certificate fingerprint. */
  readonly remoteFingerprint: string;
  /** Opens a channel; resolves once it is open. */
  open(label: string): Promise<Channel>;
  onClose(cb: () => void): void;
  close(): void;
}
