# Deploy SMDApp to Render (Free)

## One-time Setup (5 minutes)

### 1. Push to GitHub
```bash
cd /home/sachin/Desktop/SMDApp
git init
git add -A
git commit -m "SMDApp for Render deploy"
git remote add origin https://github.com/YOUR_USERNAME/smdapp.git
git push -u origin main
```

### 2. Create Render Account
- Go to https://render.com
- Sign up with GitHub (free, no credit card)

### 3. Deploy
- Click **New +** → **Blueprint**
- Select your `smdapp` repo
- Render auto-detects `render.yaml`
- Click **Apply**

### 4. Set Environment Variables
In Render Dashboard → **Environment** tab, add:

| Variable | Value |
|---|---|
| `BREEZE_API_KEY` | from your .env |
| `BREEZE_SECRET_KEY` | from your .env |
| `BREEZE_SESSION_TOKEN` | from your .env |
| `TELEGRAM_BOT_TOKEN` | from your .env |
| `TELEGRAM_CHAT_ID` | from your .env |
| `GROQ_API_KEY` | from your .env |
| `OPENROUTER_API_KEY` | from your .env |
| `TOKENRA_API_KEY` | from your .env |

### 5. Access Your App
- Render gives you: `https://smdapp-xxxx.onrender.com`
- Open on mobile/laptop/PC — works anywhere

## Limitations (Free Tier)

| Limitation | Impact |
|---|---|
| **512MB RAM** | Sidecars (trade audit, etc.) won't run — only core Next.js |
| **Spins down after 15min idle** | First visit after idle takes ~30s to wake up |
| **No persistent disk** | SQLite DB wiped on restart — trade history lost |
| **750 hrs/month** | Enough for personal use |

## If You Need Persistent Storage

Upgrade to **Render Starter** ($7/month) — adds:
- Persistent disk (SQLite survives restarts)
- No spin-down (always awake)
- More RAM

## Access From Mobile
1. Open your Render URL on phone browser
2. Add to Home Screen (PWA-like)
3. Works on 4G/WiFi — no local server needed
