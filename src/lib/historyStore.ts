// lib/historyStore.ts
//
// Minimal per-chat conversation history. Keyed by chat/user id so
// each Telegram user (or in-app session) gets their own context.
//
// This in-memory version resets on server restart and won't work
// across multiple server instances — swap the Map for Redis/DB-backed
// storage before running this in a multi-instance production deploy.

import type { ChatTurn } from "./sdmChat";

const MAX_TURNS = 6;
const store = new Map<string, ChatTurn[]>();

export function getHistory(chatId: string): ChatTurn[] {
  return store.get(chatId) ?? [];
}

export function appendTurn(chatId: string, turn: ChatTurn): void {
  const existing = store.get(chatId) ?? [];
  const updated = [...existing, turn].slice(-MAX_TURNS);
  store.set(chatId, updated);
}

export function clearHistory(chatId: string): void {
  store.delete(chatId);
}
