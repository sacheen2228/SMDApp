// instrumentation.ts — runs once on Next.js server start
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // Auto-set Telegram webhook on server start
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || process.env.VERCEL_URL
      ? `https://${process.env.VERCEL_URL}`
      : process.env.RENDER_EXTERNAL_URL || null;

    if (token && baseUrl) {
      try {
        const webhookUrl = `${baseUrl}/api/telegram/webhook`;
        const res = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: webhookUrl }),
        });
        const data = await res.json();
        console.log(`[Telegram] Webhook auto-set: ${data.ok ? "OK" : data.description}`);
      } catch (err: any) {
        console.warn(`[Telegram] Webhook auto-set failed: ${err.message}`);
      }
    }
  }
}
