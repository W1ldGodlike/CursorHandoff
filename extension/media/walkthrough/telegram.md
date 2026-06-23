## Telegram bot integration

Get notifications and run Cursor commands from a Telegram supergroup with forum topics.

### Checklist

1. Bot token from [@BotFather](https://t.me/BotFather) (`/newbot`)
2. Your numeric ID from [@userinfobot](https://t.me/userinfobot)
3. Supergroup with **Topics** enabled; bot as **administrator** with **Manage Topics**

In **Handoff settings** → **Telegram**, complete all five steps. Then in the group: `/register <token>` (any topic), then `/bridge` or `/bridge_all` in **# General**.

Docs: [Telegram bridge guide](command:cursorHandoff.openDoc?%22docs%2Ftelegram.md%22) · [If the bot won't connect](command:cursorHandoff.openDoc?%22docs%2Ftelegram.md%23bot-wont-connect%22).
