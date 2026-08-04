import { useSyncExternalStore } from "react";

function subscribeNoop() {
  return () => {};
}

/**
 * Client/server gate that stays false during SSR + hydration, then true on the client.
 * Prefer this over useState+useEffect(setMounted) to avoid cascading-render lint violations.
 */
export function useIsClient() {
  return useSyncExternalStore(subscribeNoop, () => true, () => false);
}
