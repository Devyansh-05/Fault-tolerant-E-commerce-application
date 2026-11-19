import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Polls `fetcher` every `intervalMs`:
 *  - never overlaps requests (a slow response simply delays the next poll)
 *  - pauses while the browser tab is hidden and refreshes when it becomes visible
 *  - cleans up on unmount / dependency change
 *  - on failure keeps the last data but reports `error` so the UI can mark it as stale
 */
export function usePolling(fetcher, intervalMs, deps = [], { enabled = true } = {}) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState(null);
  const inFlight = useRef(false);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const result = await fetcherRef.current();
      setData(result);
      setError(null);
      setLastUpdated(new Date());
    } catch (err) {
      setError(err);
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    refresh();
    if (!enabled) return undefined;
    const timer = setInterval(() => {
      if (!document.hidden) refresh();
    }, intervalMs);
    const onVisible = () => !document.hidden && refresh();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intervalMs, enabled, refresh, ...deps]);

  return { data, error, loading, lastUpdated, refresh };
}
