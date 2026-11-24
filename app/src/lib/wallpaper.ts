import { create } from 'zustand';

/*
 * A picture of the person's own behind the sidebar and the chat, kept per device like the theme: a
 * phone and a wide monitor want different pictures. The picture lives in IndexedDB, as photos are
 * too large for localStorage; the page shows it through a blob: address, which the web app's
 * Content-Security-Policy allows for images.
 */

const DB_NAME = 'leafbot-wallpaper';
const STORE = 'images';
const IMAGE_KEY = 'current';
const DIM_KEY = 'leafbot.wallpaper.dim';
const BLUR_KEY = 'leafbot.wallpaper.blur';
const OWN_BUBBLE_KEY = 'leafbot.wallpaper.ownBubble';

/** How much of the theme's own background lies over the picture, in percent: text must stay readable. */
export const DIM_MIN = 0;
export const DIM_MAX = 85;
export const DIM_DEFAULT = 45;
/** The longest side the picture is kept at: sharp on a large screen, small enough to load at once. */
export const LONG_EDGE = 2560;
/** A larger file is not a photo the browser can turn into a picture quickly. */
export const MAX_FILE_BYTES = 40 * 1024 * 1024;

export function clampDim(value: unknown): number {
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n)) return DIM_DEFAULT;
  return Math.round(Math.min(DIM_MAX, Math.max(DIM_MIN, n)));
}

/**
 * How the person's own bubbles sit over the picture: frosted like the rest, or filled with their
 * colour, which keeps their white text readable over any picture.
 */
export type OwnBubble = 'glass' | 'solid';

/** Frosted glass by default: the picture comes through as colour, never as shapes behind the text. */
function readBlur(): boolean {
  try {
    return localStorage.getItem(BLUR_KEY) !== 'off';
  } catch {
    return true;
  }
}

function readOwnBubble(): OwnBubble {
  try {
    return localStorage.getItem(OWN_BUBBLE_KEY) === 'solid' ? 'solid' : 'glass';
  } catch {
    return 'glass';
  }
}

function store(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Held for this page.
  }
}

function readDim(): number {
  try {
    const v = localStorage.getItem(DIM_KEY);
    return v === null ? DIM_DEFAULT : clampDim(v);
  } catch {
    return DIM_DEFAULT;
  }
}

/** The size a picture of `width` × `height` is kept at: its own, or scaled down to LONG_EDGE. */
export function fitSize(
  width: number,
  height: number,
  longEdge = LONG_EDGE,
): { width: number; height: number } {
  const scale = Math.min(1, longEdge / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

function openDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  return new Promise((resolve) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    // A private window may refuse storage; the picture then lasts only as long as the page.
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
}

async function readImage(): Promise<Blob | null> {
  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve) => {
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(IMAGE_KEY);
    req.onsuccess = () => resolve(req.result instanceof Blob ? req.result : null);
    req.onerror = () => resolve(null);
  });
}

async function writeImage(image: Blob | null): Promise<void> {
  const db = await openDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    if (image) store.put(image, IMAGE_KEY);
    else store.delete(IMAGE_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
    tx.onabort = () => resolve();
  });
}

/**
 * The chosen file as a JPEG no larger than LONG_EDGE: a phone photo is often 10 MB or more, and
 * drawing it again also drops what the camera wrote into it (the place it was taken, among others).
 */
export async function shrink(file: Blob): Promise<Blob> {
  if (file.size > MAX_FILE_BYTES) throw new WallpaperError('tooLarge');
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new WallpaperError('unreadable');
  }
  try {
    const { width, height } = fitSize(bitmap.width, bitmap.height);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new WallpaperError('unreadable');
    ctx.drawImage(bitmap, 0, 0, width, height);
    const out = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.86));
    if (!out) throw new WallpaperError('unreadable');
    return out;
  } finally {
    bitmap.close();
  }
}

export class WallpaperError extends Error {
  constructor(readonly reason: 'tooLarge' | 'unreadable') {
    super(reason);
  }
}

interface Look {
  dim: number;
  blur: boolean;
  ownBubble: OwnBubble;
}

function apply(url: string | null, look: Look) {
  const root = document.documentElement;
  root.toggleAttribute('data-wallpaper', !!url);
  root.toggleAttribute('data-wallpaper-sharp', !look.blur);
  root.toggleAttribute('data-wallpaper-solid', look.ownBubble === 'solid');
  root.style.setProperty('--wallpaper-dim', `${look.dim}%`);
}

interface WallpaperState {
  /** The picture's blob: address while one is chosen. */
  url: string | null;
  dim: number;
  /** Whether the panels and bubbles blur the picture behind them, or let it show sharp. */
  blur: boolean;
  ownBubble: OwnBubble;
  choose(file: Blob): Promise<void>;
  remove(): Promise<void>;
  setDim(dim: number): void;
  setBlur(blur: boolean): void;
  setOwnBubble(ownBubble: OwnBubble): void;
}

export const useWallpaper = create<WallpaperState>((set, get) => {
  const show = (image: Blob | null) => {
    const old = get().url;
    const url = image ? URL.createObjectURL(image) : null;
    apply(url, get());
    set({ url });
    if (old) URL.revokeObjectURL(old);
  };
  const look: Look = { dim: readDim(), blur: readBlur(), ownBubble: readOwnBubble() };
  if (typeof document !== 'undefined') apply(null, look);
  void readImage().then((image) => {
    if (image && !get().url) show(image);
  });
  return {
    url: null,
    ...look,
    choose: async (file) => {
      const image = await shrink(file);
      await writeImage(image);
      show(image);
    },
    remove: async () => {
      await writeImage(null);
      show(null);
    },
    setDim: (value) => {
      const next = clampDim(value);
      store(DIM_KEY, String(next));
      apply(get().url, { ...get(), dim: next });
      set({ dim: next });
    },
    setBlur: (blur) => {
      store(BLUR_KEY, blur ? 'on' : 'off');
      apply(get().url, { ...get(), blur });
      set({ blur });
    },
    setOwnBubble: (ownBubble) => {
      store(OWN_BUBBLE_KEY, ownBubble);
      apply(get().url, { ...get(), ownBubble });
      set({ ownBubble });
    },
  };
});
