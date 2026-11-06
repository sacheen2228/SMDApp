// lib/telegramSend.ts
//
// Thin wrapper around telegram.ts sendTelegramMessage. Kept for backward
// compatibility with existing callers. New code should import from
// "@/lib/telegram" directly.

import { sendTelegramMessage as sendTelegramMessageCore } from "./telegram";

export async function sendTelegramMessage(
  chatId: string | number,
  text: string
): Promise<boolean> {
  return sendTelegramMessageCore(text, String(chatId));
}
