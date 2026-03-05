import { useState, useEffect, useCallback } from 'react';
import { initDB, loadAllChats, saveChat, deleteChat } from '../lib/db';
import type { ChatRecord } from '../types';

export function useDB() {
  const [chats, setChats] = useState<ChatRecord[]>([]);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    initDB().then(() => {
      setReady(true);
      loadAllChats().then(setChats);
    });
  }, []);

  const refresh = useCallback(async () => {
    const all = await loadAllChats();
    setChats(all);
  }, []);

  const save = useCallback(async (chat: ChatRecord) => {
    await saveChat(chat);
    await refresh();
  }, [refresh]);

  const remove = useCallback(async (id: string) => {
    await deleteChat(id);
    await refresh();
  }, [refresh]);

  const clearAll = useCallback(async () => {
    const all = await loadAllChats();
    for (const c of all) await deleteChat(c.id);
    await refresh();
  }, [refresh]);

  return { chats, ready, save, remove, clearAll, refresh };
}
