// lib/telegramSend.ts
//
// Thin wrapper around the Telegram Bot API sendMessage. Kept separate
// from the webhook route so the cron process and the digest/alert
// modules can all share one sender.

const TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";

export async function sendTelegramMessage(
  chatId: string | number,
  text: string
): Promise<boolean> {
  if (!TOKEN) {
    console.error("[telegramSend] TELEGRAM_BOT_TOKEN not set — cannot send");
    return false;
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "Markdown",
        disable_web_page_preview: true,
      }),
    });
    if (!res.ok) {
      const err = await res.text().catch(() => "");
      console.error("[telegramSend] send failed:", res.status, err.slice(0, 200));
      return false;
    }
    return true;
  } catch (err) {
    console.error("[telegramSend] send error:", err);
    return false;
  }
}
