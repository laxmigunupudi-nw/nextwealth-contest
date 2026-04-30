# NextWealth Prompt Engineering Contest

## Files
- `participant.html` — shared with contestants
- `admin.html` — admin only (password protected)
- `api/score.js` — backend scoring engine (Vercel serverless)
- `vercel.json` — Vercel routing config

## Deploy to Vercel (5 minutes)

### Step 1 — Create GitHub repo
1. Go to github.com → New repository
2. Name: `nextwealth-contest`
3. Set to **Public**
4. Click Create repository

### Step 2 — Upload files
Upload ALL files maintaining the folder structure:
```
nextwealth-contest/
├── participant.html
├── admin.html
├── vercel.json
├── api/
│   └── score.js
└── README.md
```

### Step 3 — Connect to Vercel
1. Go to vercel.com → Sign up with GitHub (free)
2. Click "Add New Project"
3. Import your `nextwealth-contest` repo
4. Click Deploy

### Step 4 — Set environment variable
In Vercel → Project Settings → Environment Variables:
- Name: `ADMIN_PASSWORD`
- Value: `Admin123`
- Click Save → Redeploy

### Step 5 — Your URLs
- **Participant link:** `https://nextwealth-contest.vercel.app/participant`
- **Admin link:** `https://nextwealth-contest.vercel.app/admin`

## Admin Login
- API Key: Your Anthropic API key (sk-ant-...)
- Password: Admin123

## How it works
1. Participants open `/participant` → fill registration → answer 8 questions → submit
2. Backend scores all 8 prompts using Claude AI
3. Participant sees their score instantly
4. Admin opens `/admin` → sees live leaderboard updating in real time
5. Admin can export full results as CSV

## Notes
- Scores are stored in-memory on Vercel (persist per deployment)
- For permanent storage across deployments, upgrade to Vercel KV (free tier available)
- Auto-refresh every 30 seconds on admin dashboard
