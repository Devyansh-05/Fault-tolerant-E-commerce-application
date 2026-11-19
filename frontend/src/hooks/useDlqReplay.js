import { useCallback } from 'react';
import { monitoringService } from '../services/monitoringService.js';
import { useToast } from '../context/ToastContext.jsx';
import { getErrorMessage } from '../utils/errors.js';

/** Confirms and triggers a DLQ replay; the record turns COMPLETED only if processing succeeds. */
export function useDlqReplay(onDone) {
  const toast = useToast();
  return useCallback(
    async (eventId, consumer, after) => {
      if (!window.confirm(`Replay event ${eventId.slice(0, 8)}… for the ${consumer} consumer?\nIt will be processed again through the normal pipeline.`)) return;
      try {
        const res = await monitoringService.replay(eventId, consumer);
        toast.success(res.message);
        after?.();
        onDone?.();
      } catch (err) {
        toast.error(getErrorMessage(err));
      }
    },
    [toast, onDone]
  );
}
