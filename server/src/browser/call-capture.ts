/**
 * Listening to a call in the bot's browser: a script in the page takes the other people's audio as
 * the page itself receives it (the WebRTC tracks and the media elements that play them), mixes it,
 * and hands it out in short recordings through a binding. Nothing is installed in the computer and
 * no sound device is needed; the bot joins with its usual browser steps, and the page plays what it
 * hears as it would anyway.
 */

/** The page calls this with each recording, as base64 WebM/Opus. */
export const CALL_BINDING = '__leafbotCallAudio';

/** How long each recording is: long enough to keep whole sentences, well under the speech-to-text limits. */
export const SEGMENT_MS = 30_000;

/** Below this peak level (0..1) a recording is taken as silence and not sent at all. */
export const SILENCE_PEAK = 0.01;

/** What the page reports when asked. */
export interface CaptureState {
  listening: boolean;
  /** Audio tracks of other people being heard now. */
  tracks: number;
  /** `running`, or `suspended` until the page gets a click or a key. */
  audio: string;
}

/**
 * Runs in the page, on every new document of the bot's browser once installed. Inert until
 * `__leafbotCall.start()`: before that it only remembers the audio tracks the page receives, so a
 * call joined before listening started is still heard. Kept as text, not a function: a compiled
 * function may call helpers of the bundler that do not exist in the page.
 */
const CAPTURE = `(binding, segmentMs, silencePeak) => {
  if (window.__leafbotCall) return;
  const tracks = new Map();
  const wired = new Set();
  let ctx = null, mix = null, meter = null, recorder = null, timer, scan, peak = 0, listening = false;

  const wire = (track) => {
    if (!ctx || wired.has(track.id) || track.readyState === 'ended') return;
    wired.add(track.id);
    const source = ctx.createMediaStreamSource(new MediaStream([track]));
    source.connect(mix);
    source.connect(meter);
  };
  const remember = (track) => {
    if (track.kind !== 'audio' || tracks.has(track.id)) return;
    tracks.set(track.id, track);
    track.addEventListener('ended', () => tracks.delete(track.id));
    if (listening) wire(track);
  };
  // The page's media elements: what it plays is what the people in the call say.
  const look = () => {
    for (const el of document.querySelectorAll('audio, video')) {
      const src = el.srcObject;
      if (src instanceof MediaStream) src.getAudioTracks().forEach(remember);
    }
  };
  // Connections made from now on: each incoming audio track, as it arrives.
  const Native = window.RTCPeerConnection;
  if (Native) {
    const Wrapped = function (...args) {
      const pc = new Native(...args);
      pc.addEventListener('track', (e) => remember(e.track));
      return pc;
    };
    Wrapped.prototype = Native.prototype;
    Object.setPrototypeOf(Wrapped, Native);
    window.RTCPeerConnection = Wrapped;
  }

  const record = () => {
    if (!listening) return;
    peak = 0;
    const r = new MediaRecorder(mix.stream, { mimeType: 'audio/webm;codecs=opus' });
    recorder = r;
    const parts = [];
    const level = new Float32Array(meter.fftSize);
    const sample = setInterval(() => {
      meter.getFloatTimeDomainData(level);
      for (const v of level) peak = Math.max(peak, Math.abs(v));
    }, 200);
    r.ondataavailable = (e) => { if (e.data.size) parts.push(e.data); };
    r.onstop = () => {
      clearInterval(sample);
      // Read when sending: the binding may be added after this script ran.
      const send = window[binding];
      if (peak >= silencePeak && parts.length && typeof send === 'function') {
        new Blob(parts, { type: 'audio/webm' }).arrayBuffer().then((buf) => {
          const bytes = new Uint8Array(buf);
          let bin = '';
          for (let i = 0; i < bytes.length; i += 0x8000)
            bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
          return send(btoa(bin));
        });
      }
      record();
    };
    r.start();
    timer = setTimeout(() => { if (r.state === 'recording') r.stop(); }, segmentMs);
  };
  const wake = () => { if (ctx) ctx.resume(); };

  window.__leafbotCall = {
    start(ms) {
      if (listening) return;
      if (ms > 0) segmentMs = ms;
      listening = true;
      ctx = new AudioContext();
      mix = ctx.createMediaStreamDestination();
      meter = ctx.createAnalyser();
      meter.fftSize = 2048;
      // A page may only start sound after a click or a key; the bot's own click to join is one.
      addEventListener('pointerdown', wake, true);
      addEventListener('keydown', wake, true);
      look();
      tracks.forEach(wire);
      scan = setInterval(() => { look(); tracks.forEach(wire); }, 2000);
      record();
    },
    stop() {
      if (!listening) return;
      listening = false;
      clearTimeout(timer);
      clearInterval(scan);
      // The last recording is still sent: what was said just before the end counts too.
      if (recorder && recorder.state === 'recording') recorder.stop();
      removeEventListener('pointerdown', wake, true);
      removeEventListener('keydown', wake, true);
      const done = ctx;
      setTimeout(() => done.close(), 1000);
      ctx = null;
      wired.clear();
    },
    state() {
      // A track ends when its connection closes: the people still heard, not all ever heard.
      let live = 0;
      for (const track of tracks.values()) if (wired.has(track.id) && track.readyState === 'live') live++;
      return { listening, tracks: live, audio: ctx ? ctx.state : 'none' };
    },
  };
  // A track that starts before listening is still remembered.
  setInterval(look, 2000);
}`;

/** The script for `addInitScript` and `evaluate`, with the recording length (shorter in tests). */
export function captureScript(segmentMs = SEGMENT_MS): string {
  return `(${CAPTURE})(${JSON.stringify(CALL_BINDING)}, ${segmentMs}, ${SILENCE_PEAK});`;
}

export const CALL_CAPTURE_SCRIPT = captureScript();
