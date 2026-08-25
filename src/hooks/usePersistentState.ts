import { useState, useEffect, Dispatch, SetStateAction } from 'react';
import { getCachedStoredItem, getStoredItem, setStoredItem, removeStoredItem } from '../lib/store';

function parseStoredState<T>(key: string, stored: string | null | undefined, fallback: T): T {
  if (stored === null || stored === undefined) return fallback;
  try {
    return JSON.parse(stored) as T;
  } catch (e) {
    console.error(`Failed to parse stored state for key "${key}"`, e);
    return fallback;
  }
}

export function usePersistentState<T>(key: string, initialState: T): [T, Dispatch<SetStateAction<T>>, () => void, boolean] {
  const cachedState = getCachedStoredItem(key);
  const [state, setState] = useState<T>(() => parseStoredState(key, cachedState, initialState));
  const [isLoaded, setIsLoaded] = useState(cachedState !== undefined);

  useEffect(() => {
    let mounted = true;
    getStoredItem(key).then((stored) => {
      if (mounted) {
        if (stored !== null) setState(parseStoredState(key, stored, initialState));
        setIsLoaded(true);
      }
    });
    return () => { mounted = false; };
  }, [key]);

  useEffect(() => {
    if (isLoaded) {
      setStoredItem(key, JSON.stringify(state));
    }
  }, [key, state, isLoaded]);

  const clearStoredState = () => {
      removeStoredItem(key);
  };

  return [state, setState, clearStoredState, isLoaded];
}
