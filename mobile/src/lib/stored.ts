import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCallback, useEffect, useSyncExternalStore } from 'react';

/**
 * Small values kept on this phone only (drafts, mutes, the last tab, the theme), read once and
 * then shared by every screen that uses the same key.
 */
const values = new Map<string, unknown>();
const loading = new Set<string>();
const listeners = new Set<() => void>();

function emit() {
  for (const fn of listeners) fn();
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

function load(key: string) {
  if (values.has(key) || loading.has(key)) return;
  loading.add(key);
  AsyncStorage.getItem(key)
    .then((raw) => (raw === null ? undefined : (JSON.parse(raw) as unknown)))
    .catch(() => undefined)
    .then((v) => {
      loading.delete(key);
      // A write that came first wins over what was stored.
      if (values.has(key)) return;
      values.set(key, v);
      emit();
    });
}

/** Reads a kept value without a hook, for code outside components; undefined until loaded. */
export function readStored<T>(key: string): T | undefined {
  load(key);
  return values.get(key) as T | undefined;
}

/** Reads a kept value once it has been read from the phone, for code outside components. */
export async function loadStored<T>(key: string): Promise<T | undefined> {
  load(key);
  if (!values.has(key))
    await new Promise<void>((resolve) => {
      const off = subscribe(() => {
        if (!values.has(key)) return;
        off();
        resolve();
      });
    });
  return values.get(key) as T | undefined;
}

export function writeStored<T>(key: string, value: T | undefined) {
  values.set(key, value);
  emit();
  const done =
    value === undefined ? AsyncStorage.removeItem(key) : AsyncStorage.setItem(key, JSON.stringify(value));
  // Not kept only means the phone forgets it next launch.
  done.catch(() => undefined);
}

/** A value kept on this phone, with `fallback` until it is read or when none was kept. */
export function useStored<T>(key: string, fallback: T): [T, (v: T) => void, boolean] {
  useEffect(() => load(key), [key]);
  const stored = useSyncExternalStore(subscribe, () => values.get(key) as T | undefined);
  const loaded = useSyncExternalStore(subscribe, () => values.has(key));
  const set = useCallback((v: T) => writeStored(key, v), [key]);
  return [stored === undefined ? fallback : stored, set, loaded];
}
