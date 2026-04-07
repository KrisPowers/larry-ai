import { useCallback, useEffect, useState } from 'react';
import {
  loadReplyPreferences,
  REPLY_PREFERENCES_STORAGE_KEY,
  REPLY_PREFERENCES_UPDATED_EVENT,
  removeReplyPreference,
  upsertReplyPreference,
} from '../lib/replyPreferences';
import type { ReplyPreferenceRecord } from '../types';

export function useReplyPreferences() {
  const [replyPreferences, setReplyPreferences] = useState<ReplyPreferenceRecord[]>([]);

  const refresh = useCallback(() => {
    setReplyPreferences(loadReplyPreferences());
  }, []);

  useEffect(() => {
    refresh();

    const handleStorage = (event: StorageEvent) => {
      if (!event.key || event.key === REPLY_PREFERENCES_STORAGE_KEY) {
        refresh();
      }
    };
    const handleUpdate = () => refresh();

    window.addEventListener('storage', handleStorage);
    window.addEventListener(REPLY_PREFERENCES_UPDATED_EVENT, handleUpdate);

    return () => {
      window.removeEventListener('storage', handleStorage);
      window.removeEventListener(REPLY_PREFERENCES_UPDATED_EVENT, handleUpdate);
    };
  }, [refresh]);

  const savePreference = useCallback((entry: Omit<ReplyPreferenceRecord, 'createdAt' | 'updatedAt'>) => {
    const next = upsertReplyPreference(entry);
    setReplyPreferences(next);
  }, []);

  const deletePreference = useCallback((id: string) => {
    const next = removeReplyPreference(id);
    setReplyPreferences(next);
  }, []);

  return {
    replyPreferences,
    saveReplyPreference: savePreference,
    removeReplyPreference: deletePreference,
    refreshReplyPreferences: refresh,
  };
}
