# INFERNO — Uncharted SMP Bot

Invite tracking (counts who invited whom when someone joins), invite leaderboard, and a private ticket system.

## Setup

1. Install deps: `npm install`
2. Copy `.env.example` to `.env` and set `DISCORD_TOKEN=<your INFERNO bot token>`
3. Run: `npm start`

## Commands

- `!invite` — your invite count
- `!invite @user` — someone else's count
- `!invite-top` / `!leaderboard` — top 10 inviters
- `!ticket` — how to open a support ticket
- `!help`

## Features

- **Invite tracker** — on every join it compares invite uses and announces `X was invited by Y (Y has N invites)` in `⌖・welcome`. Counts are stored in `invites.json` (created automatically).
- **Tickets** — the bot keeps a panel in `🎫・tickets` with an "Open a Ticket" button. Each ticket is a private channel; the opener and staff can close it, and closing asks before deleting the channel.

## 24/7 hosting

The bot must be running for invite counts and tickets to work. To host it 24/7:

1. Create a **private GitHub repo** with this folder (never commit `.env` — it's gitignored).
2. Create a project on [Railway](https://railway.app) (or similar) and deploy from that repo.
3. Add an environment variable `DISCORD_TOKEN` in the host's settings with your bot token.
4. The start command is `npm start` (already in `package.json`).

Note: your privileged intents are already enabled in the Developer Portal (Server Members, Message Content).
