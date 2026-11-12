# 🏏 Virtual Cricket Universe — Web Platform & Live Center

The official, standalone web platform and live broadcasting center for the **Virtual Cricket Universe**. This repository contains the complete, decoupled web application and API server designed for 24/7 standalone hosting (Render, Railway, VPS, Docker, Heroku, etc.) connected to your central PostgreSQL database.

---

## 🌟 Key Features

- **🔴 Real-Time Live Center**: Live match status, current batters (runs, balls, SR, 4s, 6s), active bowler (overs, maidens, economy), CRR/RRR, target chase, and direct Discord channel streaming jump links.
- **🏆 Multi-Stage Tournament Standings**:
  - Full parity with the Discord bot's `/standings` engine.
  - Supports **Preliminary Groups** (Group A, Group B, Group C, etc.) with group qualification badges.
  - Supports **Super Stage** (Super 6, Super 8, Super 12) with dedicated stage navigation tabs.
  - Accurate calculation of **Net Run Rate (NRR)** for white-ball cricket and **Quotient** for First-Class/Test matches.
  - Format-aware tournament top run-scorers and leading wicket-takers (`tourney lb`).
- **👤 Player Dossier & Deep Search**:
  - Filter by Country, Role (Batter, Bowler, All-Rounder, Wicket Keeper), Archetype, Traits, and Rating Tiers.
  - Instant dossier lookup (<10ms) showing career statistics, ratings radar, and recent match innings.
  - **Head-to-Head Comparison**: Compare any two players across all formats or filter by Test, ODI, or Short Formats.
- **👑 Rankings Center**:
  - **International**: Official ICC-style snapshots for T20, ODI, and Test matches (Batting, Bowling, All-Rounders).
  - **Domestic**: League & First-Class rankings aggregated across franchise and domestic tournaments.
  - **Overall**: Universal rankings spanning all players in the simulation.
- **🎨 Royal Red, Black & Gold Theme**:
  - Sleek, modern cyber-sports aesthetic with high-contrast crimson accents, gold highlights, and deep obsidian dark mode.
  - Fully responsive on mobile, tablet, and desktop with a fixed bottom navigation bar and touch-friendly controls.

---

## 🚀 Quick Start (Local Setup)

### 1. Prerequisites
- **Node.js**: v18.0.0 or higher
- **PostgreSQL**: Access to your Virtual Cricket database

### 2. Installation
```bash
git clone https://github.com/ImthiyazAhmed07/Virtual-Universe.git
cd Virtual-Universe
npm install
```

### 3. Environment Variables
Create a `.env` file in the root directory:
```env
PORT=3000
DATABASE_URL=postgresql://username:password@hostname:5432/virtual_cricket
DATABASE_SSL=false
```

### 4. Run the Server
```bash
# Production start
npm start

# Development mode (auto-reload on change)
npm run dev
```

Visit `http://localhost:3000` in your browser.

---

## ☁️ Deployment Guide

### Deploying to Vercel (Serverless Full-Stack)
1. Go to [Vercel Dashboard](https://vercel.com/) and click **Add New** -> **Project**.
2. Import your GitHub repository `ImthiyazAhmed07/Virtual-Universe`.
3. In **Environment Variables**, add:
   - **Key**: `DATABASE_URL`
   - **Value**: Your PostgreSQL connection string (e.g. from Supabase, Neon, Render, or VPS).
4. Click **Deploy**.
5. Vercel automatically serves the static frontend from the edge CDN and executes all `/api/*` endpoints via the included serverless handler (`api/index.js` and `vercel.json`).

### Deploying to GitHub Pages (Static Frontend)
1. Go to your repository **Settings** -> **Pages**.
2. Under **Build and deployment** -> **Source**: select **"Deploy from a branch"**.
3. Under **Branch**: choose **`main`** and folder **`/ (root)`**, then click **Save**.
4. Within 1-2 minutes, your website will be live at `https://imthiyazahmed07.github.io/Virtual-Universe/`.
5. *Note*: Since GitHub Pages only hosts static files, click the **"⚙️ API Server"** button in the website header to connect your backend API URL (from Render, Railway, or VPS) so the site can display live match scores and database stats!

### Deploying to Render (Full-Stack 24/7 - Recommended)
1. Create a new **Web Service** on [Render](https://render.com/).
2. Connect your GitHub repository `ImthiyazAhmed07/Virtual-Universe`.
3. Set the following build and start commands:
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
4. In the **Environment** tab, add your `DATABASE_URL` (your managed PostgreSQL connection string).

### Deploying to Railway
1. Click **New Project** -> **Deploy from GitHub Repo**.
2. Select `Virtual-Universe`.
3. Add variable `DATABASE_URL` in the project settings.
4. Railway will automatically detect `npm start` and assign a public domain.

### Deploying to VPS (with PM2)
```bash
git clone https://github.com/ImthiyazAhmed07/Virtual-Universe.git
cd Virtual-Universe
npm install
npm install -g pm2
pm2 start server.js --name "virtual-cricket-web"
pm2 save
pm2 startup
```

---

## 📁 Repository Structure

```
Virtual-Universe/
├── public/                 # Static Web Assets (Frontend)
│   ├── index.html          # Single Page Application entrypoint
│   ├── styles.css          # Royal Red, Black & Gold CSS design system
│   └── app.js              # Frontend logic (Live polls, search, standings tabs)
├── server.js               # Standalone Express & PostgreSQL API server
├── package.json            # Node.js project manifest & dependencies
├── .env.example            # Sample environment variables
└── README.md               # Documentation & setup guide
```

---

## 🛡️ License
MIT License. Built for the **Virtual Cricket Universe** by Imthiyaz Ahmed.
