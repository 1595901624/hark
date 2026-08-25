import { Store } from '@tauri-apps/plugin-store';

const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
const store = isTauri ? await Store.load('store.bin') : null;
const storedItemCache = new Map<string, string | null>();

export function getCachedStoredItem(key: string): string | null | undefined {
  return storedItemCache.get(key);
}

export async function getStoredItem(key: string): Promise<string | null> {
  if (storedItemCache.has(key)) return storedItemCache.get(key) ?? null;

  try {
    const val = await store?.get<string>(key);
    if (val !== null && val !== undefined) {
      storedItemCache.set(key, val);
      return val;
    }

    const localVal = localStorage.getItem(key);
    if (localVal) {
      await store?.set(key, localVal);
      await store?.save();
      localStorage.removeItem(key);
      storedItemCache.set(key, localVal);
      return localVal;
    }
  } catch (err) {
    console.error('Error in getStoredItem:', err);
  }
  storedItemCache.set(key, null);
  return null;
}

export async function setStoredItem(key: string, value: string): Promise<void> {
  storedItemCache.set(key, value);
  try {
    if (store) {
      await store.set(key, value);
      await store.save();
      localStorage.removeItem(key);
    } else {
      localStorage.setItem(key, value);
    }
  } catch (err) {
    console.error('Error in setStoredItem:', err);
  }
}

export async function removeStoredItem(key: string): Promise<void> {
  storedItemCache.set(key, null);
  try {
    await store?.delete(key);
    await store?.save();
    localStorage.removeItem(key);
  } catch (err) {
    console.error('Error in removeStoredItem:', err);
  }
}
