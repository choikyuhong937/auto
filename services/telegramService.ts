
// services/telegramService.ts

/**
 * Sends a message to a Telegram chat via the Bot API.
 * Telegram API supports CORS, so we can use normal fetch with POST.
 */
export const sendTelegramNotification = async (botToken: string, chatId: string, message: string): Promise<boolean> => {
    if (!botToken || !chatId) {
        console.warn('[Telegram] Missing botToken or chatId — skipping');
        return false;
    }

    const url = `https://api.telegram.org/bot${botToken}/sendMessage`;

    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: chatId,
                text: message,
                parse_mode: 'HTML',
            }),
        });

        if (!res.ok) {
            const errBody = await res.text();
            console.error(`[Telegram] API error ${res.status}: ${errBody}`);
            return false;
        }

        return true;
    } catch (error) {
        console.error(`[Telegram] Network error:`, error);
        return false;
    }
};
