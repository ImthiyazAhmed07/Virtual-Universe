/**
 * Virtual Cricket Global Esports Platform - Client Application
 * Features: Live Streaming, Match Center, Advanced Player Directory, Head-to-Head Compare,
 * Multi-Tier Rankings (International / Domestic / Overall), and Complete Tournament Hub.
 */

// Application State
const state = {
  currentTab: "live",
  autoRefresh: true,
  refreshIntervalMs: 4000,
  refreshTimer: null,
  
  // Live & Recent Matches
  liveMatches: [],
  recentMatches: [],
  recentFormatFilter: "all",
  
  // Players Directory & Filters
  playersPage: 1,
  playersTotalPages: 1,
  playerSearchQuery: "",
  playerCountryFilter: "All",
  playerRoleFilter: "All",
  playerTierFilter: "All",
  playerTraitFilter: "All",
  playerBowlingStyleFilter: "All",
  playerBattingStyleFilter: "All",
  playerSortBy: "overall",

  // Player Comparison
  compareP1: "",
  compareP2: "",
  compareFormat: "all",

  // Rankings & Leaderboards
  rankingsData: null,
  rankingsScope: "international",
  rankingsFormat: "odi",
  rankingsMode: "rankings", // "rankings" | "leaderboards"
  activeRankingCategory: "batting",
  activeLeaderboardCategory: "mostRuns", // "mostRuns" | "mostWickets" | "highestScores" | "bestBowling"
  _lastLiveFingerprint: "",

  // Tournaments
  tournamentsList: [],
  tournamentsFilterCat: "all",
  activeTournamentId: "",
  activeTournamentData: null,
  activeTourneySubView: "standings",
  tourneyActiveStage: "stage2",
  tourneyActiveGroup: "all",
};

// -----------------------------------------------------------------------------
// Universal API Base Configuration (Localhost / Remote Hosting / GitHub Pages)
// -----------------------------------------------------------------------------
function getApiBase() {
  if (window.VIRTUAL_CRICKET_API) return window.VIRTUAL_CRICKET_API.replace(/\/+$/, "");
  const stored = localStorage.getItem("VC_API_URL");
  if (stored) return stored.trim().replace(/\/+$/, "");
  return "";
}

function setApiBase(url) {
  if (!url || !url.trim()) {
    localStorage.removeItem("VC_API_URL");
  } else {
    let clean = url.trim().replace(/\/+$/, "");
    if (!clean.startsWith("http://") && !clean.startsWith("https://")) {
      clean = "https://" + clean;
    }
    localStorage.setItem("VC_API_URL", clean);
  }
  updateApiStatusIndicator();
  closeModal("apiConfigModal");
  // Reload current views
  switchTab(state.currentTab);
  loadOverviewStats();
}

async function apiFetch(endpoint, options = {}) {
  const base = getApiBase();
  const fullUrl = base ? `${base}${endpoint}` : endpoint;
  return fetch(fullUrl, options);
}

function updateApiStatusIndicator() {
  const pill = document.getElementById("apiStatusPill");
  const label = document.getElementById("apiStatusLabel");
  const banner = document.getElementById("ghPagesNoticeBanner");
  const base = getApiBase();
  const isGhPages = window.location.hostname.endsWith("github.io");

  if (pill && label) {
    if (base) {
      pill.className = "api-status-pill connected";
      try {
        const u = new URL(base);
        label.textContent = `API: ${u.hostname}`;
      } catch {
        label.textContent = "API: Connected";
      }
    } else if (isGhPages) {
      pill.className = "api-status-pill disconnected";
      label.textContent = "API: Offline (Configure)";
    } else {
      pill.className = "api-status-pill connected";
      label.textContent = "API: Online";
    }
  }

  if (banner) {
    if (isGhPages && !base) {
      banner.classList.remove("hidden");
    } else {
      banner.classList.add("hidden");
    }
  }
}

function openApiModal() {
  const modal = document.getElementById("apiConfigModal");
  const input = document.getElementById("apiServerUrlInput");
  const statusMsg = document.getElementById("apiTestStatus");
  if (input) input.value = getApiBase() || "";
  if (statusMsg) statusMsg.textContent = "";
  if (modal) modal.classList.remove("hidden");
}

async function testApiConnection() {
  const input = document.getElementById("apiServerUrlInput");
  const statusMsg = document.getElementById("apiTestStatus");
  if (!input || !statusMsg) return;

  let url = input.value.trim().replace(/\/+$/, "");
  if (!url) {
    statusMsg.innerHTML = `<span style="color:var(--text-muted)">Testing default relative origin...</span>`;
  } else {
    if (!url.startsWith("http://") && !url.startsWith("https://")) {
      url = "https://" + url;
    }
    statusMsg.innerHTML = `<span style="color:var(--accent-gold)">Connecting to ${url}...</span>`;
  }

  try {
    const testUrl = url ? `${url}/api/overview` : `/api/overview`;
    const res = await fetch(testUrl, { signal: AbortSignal.timeout(6000) });
    const data = await res.json();
    if (data.success) {
      statusMsg.innerHTML = `<span style="color:var(--accent-green)">✅ Connection Successful! (${data.totalMatches} matches recorded in database)</span>`;
    } else {
      statusMsg.innerHTML = `<span style="color:var(--accent-red)">⚠️ Server responded with error: ${data.error || "Unknown"}</span>`;
    }
  } catch (err) {
    statusMsg.innerHTML = `<span style="color:var(--accent-red)">❌ Could not reach server: ${err.message}. Ensure CORS is enabled and URL is active.</span>`;
  }
}

// -----------------------------------------------------------------------------
// Universal Cricket Overs Formatter Helper
// -----------------------------------------------------------------------------
function formatCricketOvers(val, balls) {
  if (typeof balls === "number" && !isNaN(balls) && balls > 0) {
    return `${Math.floor(balls / 6)}.${balls % 6}`;
  }
  if (typeof val === "number" && !isNaN(val)) {
    const whole = Math.floor(val);
    const frac = val - whole;
    if (frac === 0) return `${whole}.0`;
    const remBalls = Math.round(frac * 6);
    if (remBalls >= 6) return `${whole + 1}.0`;
    return `${whole}.${remBalls}`;
  }
  if (typeof val === "string") {
    const num = parseFloat(val);
    if (!isNaN(num)) return formatCricketOvers(num, null);
    return val;
  }
  return "0.0";
}

// -----------------------------------------------------------------------------
// DOM Content Loaded & Initialization
// -----------------------------------------------------------------------------
document.addEventListener("DOMContentLoaded", () => {
  updateApiStatusIndicator();
  initNavigation();
  initAutoRefresh();
  initPlayerSearchDebounce();
  initCompareAutocomplete();
  renderFormatPills(state.rankingsScope);

  // Initial Data Load
  loadLiveStreams();
  loadRecentMatches();
  loadOverviewStats();
});

// -----------------------------------------------------------------------------
// Navigation (Desktop & Mobile Synchronized)
// -----------------------------------------------------------------------------
function initNavigation() {
  const validTabs = ["live", "matches", "players", "compare", "rankings", "tournaments"];
  const hash = window.location.hash.replace("#", "");
  if (hash && validTabs.includes(hash)) {
    switchTab(hash);
  }

  window.addEventListener("hashchange", () => {
    const h = window.location.hash.replace("#", "");
    if (h && validTabs.includes(h)) {
      switchTab(h);
    }
  });
}

function switchTab(tabId) {
  state.currentTab = tabId;
  window.location.hash = tabId;

  // Update Desktop Nav Buttons
  document.querySelectorAll(".nav-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.tab === tabId);
  });

  // Update Mobile Bottom Nav Buttons
  document.querySelectorAll(".mob-nav-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.tab === tabId);
  });

  // Update Sections
  document.querySelectorAll(".tab-section").forEach((sec) => {
    sec.classList.toggle("hidden", sec.id !== `tab-${tabId}`);
    sec.classList.toggle("active", sec.id === `tab-${tabId}`);
  });

  // Lazy load tab data
  if (tabId === "live") {
    loadLiveStreams();
  } else if (tabId === "matches") {
    loadRecentMatches();
  } else if (tabId === "players") {
    loadPlayers();
  } else if (tabId === "compare") {
    // If comparison already has inputs, refresh comparison
    if (state.compareP1 && state.compareP2) {
      runPlayerComparison();
    }
  } else if (tabId === "rankings") {
    renderFormatPills(state.rankingsScope);
    loadRankings();
  } else if (tabId === "tournaments") {
    loadTournaments();
  }

  // Scroll to top of content on mobile
  if (window.innerWidth <= 768) {
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
}

// -----------------------------------------------------------------------------
// Auto-Refresh & Synchronization
// -----------------------------------------------------------------------------
function initAutoRefresh() {
  const toggle = document.getElementById("autoRefreshToggle");
  const manualBtn = document.getElementById("manualRefreshBtn");

  toggle.addEventListener("change", (e) => {
    state.autoRefresh = e.target.checked;
    if (state.autoRefresh) {
      startRefreshTimer();
    } else {
      stopRefreshTimer();
    }
  });

  manualBtn.addEventListener("click", () => {
    manualBtn.classList.add("spinning");
    refreshActiveTabData().finally(() => {
      setTimeout(() => manualBtn.classList.remove("spinning"), 600);
    });
  });

  startRefreshTimer();
}

function startRefreshTimer() {
  stopRefreshTimer();
  state.refreshTimer = setInterval(() => {
    if (state.autoRefresh) {
      // Do not poll if user has a modal open to prevent interrupting inspection
      const anyModalOpen = document.querySelectorAll(".modal-backdrop:not(.hidden)").length > 0;
      if (!anyModalOpen) {
        // Poll ONLY live matches in background to keep live badge and cards updated
        // NEVER poll inactive tabs automatically to eliminate loading spinner flashes
        loadLiveStreams(true);
      }
    }
  }, state.refreshIntervalMs);
}

function stopRefreshTimer() {
  if (state.refreshTimer) {
    clearInterval(state.refreshTimer);
    state.refreshTimer = null;
  }
}

async function refreshActiveTabData(isBackground = false) {
  if (state.currentTab === "live") return loadLiveStreams(isBackground);
  if (state.currentTab === "matches") return loadRecentMatches();
  if (state.currentTab === "players") return loadPlayers();
  if (state.currentTab === "rankings") return loadRankings();
  if (state.currentTab === "tournaments") return loadTournaments();
}

// -----------------------------------------------------------------------------
// TAB 1: Live Streaming Matches
// -----------------------------------------------------------------------------
async function loadLiveStreams(isBackground = false) {
  const container = document.getElementById("liveStreamContainer");
  const liveBadge = document.getElementById("liveBadge");
  const liveBadgeText = document.getElementById("liveBadgeText");
  const activeCountTag = document.getElementById("activeMatchCount");

  try {
    const res = await apiFetch("/api/live");
    const data = await res.json();

    if (!data.success) throw new Error(data.error);
    state.liveMatches = data.matches || [];

    // Update Header Live Badge
    if (state.liveMatches.length > 0) {
      liveBadge.classList.remove("hidden");
      liveBadgeText.textContent = `${state.liveMatches.length} MATCH${state.liveMatches.length > 1 ? "ES" : ""} LIVE`;
      if (activeCountTag) {
        activeCountTag.textContent = `🟢 ${state.liveMatches.length} Match${state.liveMatches.length > 1 ? "es" : ""} In Progress`;
      }
    } else {
      liveBadge.classList.add("hidden");
      if (activeCountTag) {
        activeCountTag.textContent = "⚪ No Active Matches";
      }
    }

    if (state.currentTab === "live") {
      // Fingerprint match state so we only update DOM if something actually changed
      const liveFingerprint = JSON.stringify(state.liveMatches.map(m => [
        m.matchId, m.score, m.overs, m.crr, m.rrr,
        m.striker?.name, m.striker?.runs, m.striker?.balls,
        m.nonStriker?.name, m.nonStriker?.runs, m.nonStriker?.balls,
        m.currentBowler?.name, m.currentBowler?.wickets, m.currentBowler?.runs, m.currentBowler?.overs,
        (m.currentOverBalls || []).join(",")
      ]));

      if (state._lastLiveFingerprint !== liveFingerprint) {
        state._lastLiveFingerprint = liveFingerprint;
        renderLiveStreams(state.liveMatches);
      }
    }
  } catch (err) {
    if (!isBackground) {
      console.error("Error loading live streams:", err);
      container.innerHTML = `
        <div class="offline-stream-card">
          <div class="offline-icon">⚠️</div>
          <div class="offline-title">Unable to Connect to Live Feeds</div>
          <div class="offline-desc">${err.message || "Failed to reach the Virtual Cricket simulation engine."}</div>
          <button class="action-btn-primary" onclick="loadLiveStreams()">Retry Connection</button>
        </div>
      `;
    }
  }
}

function renderLiveStreams(matches) {
  const container = document.getElementById("liveStreamContainer");

  if (!matches || matches.length === 0) {
    container.innerHTML = `
      <div class="offline-stream-card">
        <div class="offline-icon">📡</div>
        <div class="offline-title">No Matches Currently Streaming</div>
        <div class="offline-desc">
          There are no active matches taking place in Discord right now. When matches start, real-time ball-by-ball scorecards, run-rate calculators, and channel stream links will automatically broadcast here.
        </div>
        <button class="action-btn-primary" onclick="switchTab('matches')">Browse Completed Match Archives</button>
      </div>
    `;
    return;
  }

  container.innerHTML = matches.map((m) => {
    let discordBtn = "";
    if (m.discord && m.discord.channelUrl) {
      discordBtn = `
        <a href="${m.discord.channelUrl}" target="_blank" rel="noopener noreferrer" class="discord-channel-pill" title="Jump straight to this live match channel in Discord">
          <svg class="discord-icon" viewBox="0 0 24 24">
            <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994.021-.041.001-.09-.041-.106a13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.929 1.793 8.18 1.793 12.061 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.894.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.028zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"/>
          </svg>
          Watch in ${m.discord.channelName} ↗
        </a>
      `;
    } else {
      discordBtn = `
        <span class="discord-channel-pill" style="cursor: default; opacity: 0.85;">
          ${m.discord ? m.discord.channelName : "#match-arena"}
        </span>
      `;
    }

    const ballChips = (m.currentOverBalls || []).map((b) => {
      let cls = "ball-chip";
      const bStr = String(b).trim();
      if (bStr === "0" || bStr === "•") cls += " dot";
      else if (bStr === "4") cls += " boundary-four";
      else if (bStr === "6") cls += " boundary-six";
      else if (bStr.toUpperCase().includes("W")) cls += " wicket";
      return `<div class="${cls}">${bStr}</div>`;
    }).join("");

    let equationHtml = "";
    if (m.target && m.currentInnings >= 2) {
      const runs = parseInt(m.score.split("/")[0]) || 0;
      const needed = Math.max(0, m.target - runs);
      equationHtml = `
        <div class="match-equation-banner">
          <span>⚡ <strong>${m.battingTeamName}</strong> need <strong>${needed}</strong> runs to win</span>
          <span>CRR: <strong>${m.crr}</strong> ${m.rrr ? `| RRR: <strong>${m.rrr}</strong>` : ""} | Target: <strong>${m.target}</strong></span>
        </div>
      `;
    } else {
      equationHtml = `
        <div class="match-equation-banner">
          <span>🏏 1st Innings: <strong>${m.battingTeamName}</strong> are setting the target</span>
          <span>Current Run Rate: <strong>${m.crr}</strong></span>
        </div>
      `;
    }

    const strikerHtml = m.striker ? `
      <div class="batter-live-row striker">
        <span class="batter-name-lbl"><span class="striker-star">*</span>${m.striker.name}</span>
        <span class="batter-stats-lbl">${m.striker.runs} (${m.striker.balls}b) • ${m.striker.fours}x4 ${m.striker.sixes}x6 (SR: ${m.striker.strikeRate})</span>
      </div>
    ` : `<div class="batter-live-row"><span class="text-muted">Awaiting next batter...</span></div>`;

    const nonStrikerHtml = m.nonStriker ? `
      <div class="batter-live-row">
        <span class="batter-name-lbl">${m.nonStriker.name}</span>
        <span class="batter-stats-lbl">${m.nonStriker.runs} (${m.nonStriker.balls}b) • (SR: ${m.nonStriker.strikeRate})</span>
      </div>
    ` : "";

    const bowlerHtml = m.currentBowler ? `
      <div class="bowler-live-row">
        <span class="bowler-name-lbl">🎯 ${m.currentBowler.name}</span>
        <span class="bowler-stats-lbl">${m.currentBowler.wickets}/${m.currentBowler.runs} (${formatCricketOvers(m.currentBowler.overs)} ov) • Econ: ${m.currentBowler.economy}</span>
      </div>
    ` : `<div class="bowler-live-row"><span class="text-muted">Over in progress...</span></div>`;

    const formattedTeamOvers = formatCricketOvers(m.overs);

    return `
      <div class="live-match-card">
        <div class="match-card-topbar">
          <div class="match-meta-tags">
            <span class="format-badge">${m.format}</span>
            <span class="stadium-badge">🏟️ ${m.stadiumName}</span>
            <span class="stadium-badge">📍 ${m.pitchType}</span>
            <span class="stadium-badge">⛅ ${m.weather}</span>
          </div>
          <div style="display: flex; align-items: center; gap: 8px;">
            <button class="action-btn-scorecard-top" onclick="openScorecardModal(${m.matchId || m.id})">
              📊 Scorecard
            </button>
            ${discordBtn}
          </div>
        </div>

        <div class="match-score-hero" onclick="openScorecardModal(${m.matchId || m.id})" style="cursor: pointer;" title="Click to view ongoing scorecard">
          <div class="team-score-block team-a">
            <div class="team-shield">${m.teamA.shortName || m.teamA.name.slice(0, 3)}</div>
            <div class="team-info-box">
              <span class="team-name">${m.teamA.name}</span>
              ${m.teamA.isBatting || (m.battingTeamName === m.teamA.name && !m.teamA.yetToBat) ? `
                <span class="team-score-live">${m.teamA.score || m.score} <span class="live-dot" title="Batting Now"></span></span>
                <span class="team-overs-live">(${m.teamA.overs || formattedTeamOvers} / ${m.totalOversMax} ov)</span>
              ` : m.teamA.yetToBat || (m.currentInnings <= 1 && m.battingTeamName !== m.teamA.name && !m.teamA.score) ? `
                <span class="team-score-live yet-to-bat-badge">Yet to bat</span>
              ` : `
                <span class="team-score-live completed-score">${m.teamA.score || m.score}</span>
                <span class="team-overs-live">${(m.teamA.overs || "").startsWith("(") ? m.teamA.overs : `(${m.teamA.overs || ""})`}</span>
              `}
            </div>
          </div>

          <div class="vs-center-col">
            <div class="vs-badge">VS</div>
            <div class="innings-tag">INNINGS ${m.currentInnings} OF ${m.totalInnings}</div>
          </div>

          <div class="team-score-block team-b">
            <div class="team-shield">${m.teamB.shortName || m.teamB.name.slice(0, 3)}</div>
            <div class="team-info-box">
              <span class="team-name">${m.teamB.name}</span>
              ${m.teamB.isBatting || (m.battingTeamName === m.teamB.name && !m.teamB.yetToBat) ? `
                <span class="team-score-live">${m.teamB.score || m.score} <span class="live-dot" title="Batting Now"></span></span>
                <span class="team-overs-live">(${m.teamB.overs || formattedTeamOvers} / ${m.totalOversMax} ov)</span>
              ` : m.teamB.yetToBat || (m.currentInnings <= 1 && m.battingTeamName !== m.teamB.name && !m.teamB.score) ? `
                <span class="team-score-live yet-to-bat-badge">Yet to bat</span>
              ` : `
                <span class="team-score-live completed-score">${m.teamB.score || m.score}</span>
                <span class="team-overs-live">${(m.teamB.overs || "").startsWith("(") ? m.teamB.overs : `(${m.teamB.overs || ""})`}</span>
              `}
            </div>
          </div>
        </div>

        ${equationHtml}

        <div class="crease-details-grid">
          <div class="crease-box">
            <div class="crease-box-title">🏏 Batters at the Crease</div>
            ${strikerHtml}
            ${nonStrikerHtml}
          </div>

          <div class="crease-box">
            <div class="crease-box-title">⚡ Current Bowling Attack</div>
            ${bowlerHtml}
          </div>
        </div>

        <div class="over-tracker-area">
          <span class="over-label">This Over:</span>
          <div class="ball-chips-list">
            ${ballChips.length > 0 ? ballChips : '<span style="color: var(--text-muted); font-size: 13px;">New over starting...</span>'}
          </div>
        </div>

        <div class="live-card-actions-bar">
          <button class="action-btn-scorecard-live" onclick="openScorecardModal(${m.matchId || m.id})">
            📊 View Ongoing Scorecard ➔
          </button>
        </div>
      </div>
    `;
  }).join("");
}

// -----------------------------------------------------------------------------
// TAB 2: Recent Completed Matches
// -----------------------------------------------------------------------------
async function loadRecentMatches() {
  const container = document.getElementById("recentMatchesList");
  try {
    let url = "/api/matches/recent?limit=24";
    if (state.recentFormatFilter && state.recentFormatFilter !== "all") {
      url += `&format=${state.recentFormatFilter}`;
    }

    const res = await apiFetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`HTTP error ${res.status}`);
    const data = await res.json();
    if (!data.success) throw new Error(data.error);

    state.recentMatches = data.matches || [];
    renderRecentMatches(state.recentMatches);
  } catch (err) {
    console.error("Error loading recent matches:", err);
    container.innerHTML = `<div class="loading-state"><p>Failed to load matches: ${err.message}</p></div>`;
  }
}

function filterRecentMatches(format) {
  state.recentFormatFilter = format;
  document.querySelectorAll(".filter-pill").forEach((btn) => {
    btn.classList.toggle("active", btn.textContent.toLowerCase() === format);
  });
  loadRecentMatches();
}

function renderRecentMatches(matches) {
  const container = document.getElementById("recentMatchesList");

  let liveMatchesHtml = "";
  if (state.liveMatches && state.liveMatches.length > 0) {
    liveMatchesHtml = state.liveMatches.map((lm) => {
      return `
        <div class="live-match-banner-card" onclick="openScorecardModal(${lm.matchId || lm.id})" style="cursor: pointer;" title="Click to view ongoing scorecard">
          <div class="live-banner-left">
            <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 6px; flex-wrap: wrap;">
              <span class="live-scorecard-badge">🔴 LIVE MATCH</span>
              <span style="font-size: 12px; color: var(--text-muted);">${lm.format} • ${lm.stadiumName}</span>
              <span class="channel-indicator">${lm.discord ? lm.discord.channelName : "#match-stream"}</span>
            </div>
            <div style="display: flex; align-items: center; gap: 16px; font-weight: 700; font-size: 15px; flex-wrap: wrap;">
              <span>${lm.teamA.name}: <span style="color: var(--accent-cyan);">${lm.teamA.score || lm.score || "Yet to bat"}</span></span>
              <span style="color: var(--text-muted); font-size: 12px;">vs</span>
              <span>${lm.teamB.name}: <span style="color: var(--accent-gold);">${lm.teamB.score || "Yet to bat"}</span></span>
            </div>
            <div style="font-size: 12px; color: var(--text-secondary); margin-top: 4px;">
              Innings ${lm.currentInnings} in progress • CRR: ${lm.crr}
            </div>
          </div>
          <div class="live-banner-right">
            <button class="action-btn-scorecard-live" onclick="event.stopPropagation(); openScorecardModal(${lm.matchId || lm.id})">
              📊 View Ongoing Scorecard ➔
            </button>
          </div>
        </div>
      `;
    }).join("");
  }

  if (!matches || matches.length === 0) {
    if (liveMatchesHtml) {
      container.innerHTML = liveMatchesHtml + `
        <div style="grid-column: 1 / -1; text-align: center; padding: 24px; color: var(--text-muted);">
          No completed match archives found for this filter.
        </div>
      `;
    } else {
      container.innerHTML = `
        <div style="grid-column: 1 / -1; text-align: center; padding: 48px; color: var(--text-muted);">
          No completed matches found for this filter.
        </div>
      `;
    }
    return;
  }

  const completedHtml = matches.map((m) => {
    const formattedDate = m.completedAt ? new Date(m.completedAt).toLocaleDateString(undefined, {
      month: "short", day: "numeric", hour: "2-digit", minute: "2-digit"
    }) : "Recent";

    const aOvers = formatCricketOvers(m.teamAOvers);
    const bOvers = formatCricketOvers(m.teamBOvers);

    return `
      <div class="recent-match-card" onclick="openScorecardModal(${m.id})">
        <div class="card-header-row">
          <span>${m.format} • ${m.stadiumName}</span>
          <span class="channel-indicator">${m.channel ? m.channel.name : "#match-stream"}</span>
        </div>

        <div class="teams-scores-box">
          <div class="team-line">
            <span class="team-line-name">${m.teamAName}</span>
            <span class="team-line-score">${m.teamAScore}/${m.teamAWickets} (${aOvers} ov)</span>
          </div>
          <div class="team-line">
            <span class="team-line-name">${m.teamBName}</span>
            <span class="team-line-score">${m.teamBScore}/${m.teamBWickets} (${bOvers} ov)</span>
          </div>
        </div>

        <div class="match-result-text">🏆 ${m.resultDescription || `${m.winnerTeamName} won`}</div>
        ${m.playerOfMatchName ? `<div class="pom-badge">⭐ Player of Match: ${m.playerOfMatchName}</div>` : ""}

        <div style="font-size: 11px; color: var(--text-muted); display: flex; justify-content: space-between; align-items: center; margin-top: 4px;">
          <span>${formattedDate}</span>
          <span style="color: var(--accent-cyan); font-weight: 600;">View Scorecard ➔</span>
        </div>
      </div>
    `;
  }).join("");

  container.innerHTML = liveMatchesHtml + completedHtml;
}

// -----------------------------------------------------------------------------
// Scorecard Modal
// -----------------------------------------------------------------------------
async function openScorecardModal(matchId) {
  const modal = document.getElementById("scorecardModal");
  const modalTitle = document.getElementById("scorecardModalTitle");
  const modalBody = document.getElementById("scorecardModalBody");

  modal.classList.remove("hidden");
  modalTitle.textContent = `Match #${matchId} Scorecard`;
  modalBody.innerHTML = `<div class="loading-state"><div class="spinner"></div><p>Fetching official scorecard...</p></div>`;

  try {
    const res = await apiFetch(`/api/matches/${matchId}`);
    const data = await res.json();
    if (!data.success) throw new Error(data.error);

    const m = data.match || {};
    const inns = data.innings || [];

    const isLive = m.status === "live" || m.status === "in_progress";
    const tAName = m.teamAName || m.team_a_name || "Team A";
    const tBName = m.teamBName || m.team_b_name || "Team B";
    modalTitle.innerHTML = `
      <span>${tAName} vs ${tBName} (${(m.format || "").toUpperCase()})</span>
      ${isLive ? '<span class="live-scorecard-badge" style="margin-left: 10px;">🔴 LIVE ONGOING</span>' : ''}
    `;

    const stadiumDisplay = m.stadiumName || m.stadium_name || "Official Cricket Ground";
    const channelDisplay = m.channelName || m.channel?.name || "#match-stream";

    let html = `
      <div style="background: rgba(0,0,0,0.35); padding: 16px; border-radius: var(--radius-md); border-left: 3px solid ${isLive ? 'var(--accent-crimson)' : 'var(--accent-gold)'}; margin-bottom: 20px;">
        <div style="display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px;">
          <div style="font-size: 16px; font-weight: 700; color: #fff;">
            ${isLive ? '<span style="color: var(--accent-crimson); margin-right: 6px;">●</span>' : ''}${m.resultDescription || m.result_description || "Match Completed"}
          </div>
          ${isLive ? `
            <button onclick="openScorecardModal(${matchId})" class="action-btn-scorecard-live" style="padding: 4px 10px; font-size: 11px;">
              🔄 Refresh Scorecard
            </button>
          ` : ''}
        </div>
        <div style="font-size: 13px; color: var(--text-muted); margin-top: 6px; display: flex; flex-wrap: wrap; gap: 16px; align-items: center;">
          <span>🏟️ Venue: <strong style="color: #fff;">${stadiumDisplay}</strong></span>
          <span>📺 Channel: <strong style="color: var(--accent-gold);">${channelDisplay}</strong></span>
        </div>
      </div>
    `;

    for (const inn of inns) {
      const batCard = inn.battingCard || inn.batting_card || [];
      const rawBowlCard = inn.bowlingCard || inn.bowling_card || [];
      // Filter out bowlers who didn't bowl
      const bowlCard = rawBowlCard.filter((w) => {
        const overs = Number(w.overs ?? 0);
        const balls = Number(w.balls ?? w.ballsBowled ?? w.oversBowled ?? 0);
        const wickets = Number(w.wickets ?? 0);
        const runs = Number(w.runs ?? w.runsConceded ?? 0);
        return overs > 0 || balls > 0 || wickets > 0 || runs > 0;
      });
      const innNumber = inn.inningsNumber ?? inn.innings_number ?? 1;
      const teamTitle = inn.battingTeamName || inn.teamName || (innNumber === 1 ? tAName : tBName) || `Innings ${innNumber}`;
      const runs = inn.totalRuns ?? inn.total_runs ?? 0;
      const wkts = inn.totalWickets ?? inn.total_wickets ?? 0;
      const balls = inn.totalBalls ?? inn.total_balls ?? 0;
      const totalOvers = inn.overs || formatCricketOvers(null, balls);

      html += `
        <div style="margin-top: 24px;">
          <div class="innings-section-title">
            Innings ${innNumber}: ${teamTitle} — ${runs}/${wkts} (${totalOvers} ov)
          </div>
          
          <table class="card-table">
            <thead>
              <tr>
                <th>Batter</th>
                <th>Dismissal</th>
                <th style="text-align: right;">R</th>
                <th style="text-align: right;">B</th>
                <th style="text-align: right;">4s</th>
                <th style="text-align: right;">6s</th>
                <th style="text-align: right;">SR</th>
              </tr>
            </thead>
            <tbody>
              ${batCard.length > 0 ? batCard.map((b) => `
                <tr>
                  <td style="font-weight: 600; color: #fff;">${b.name || b.playerName || "Batter"}</td>
                  <td style="color: var(--text-muted); font-size: 12px;">${b.dismissal || "not out"}</td>
                  <td style="text-align: right; font-weight: 700; color: var(--accent-gold);">${b.runs ?? 0}</td>
                  <td style="text-align: right; color: var(--text-muted);">${b.balls ?? 0}</td>
                  <td style="text-align: right;">${b.fours ?? 0}</td>
                  <td style="text-align: right;">${b.sixes ?? 0}</td>
                  <td style="text-align: right; font-family: var(--font-mono);">${b.strikeRate ?? (b.balls > 0 ? ((b.runs / b.balls) * 100).toFixed(1) : "0.0")}</td>
                </tr>
              `).join("") : `
                <tr><td colspan="7" style="text-align: center; color: var(--text-muted); padding: 12px;">Batting records not recorded</td></tr>
              `}
            </tbody>
          </table>

          <table class="card-table" style="margin-top: 14px;">
            <thead>
              <tr>
                <th>Bowler</th>
                <th style="text-align: right;">O</th>
                <th style="text-align: right;">M</th>
                <th style="text-align: right;">R</th>
                <th style="text-align: right;">W</th>
                <th style="text-align: right;">Econ</th>
              </tr>
            </thead>
            <tbody>
              ${bowlCard.length > 0 ? bowlCard.map((w) => `
                <tr>
                  <td style="font-weight: 600; color: #fff;">${w.name || w.bowlerName || "Bowler"}</td>
                  <td style="text-align: right;">${formatCricketOvers(w.overs, w.balls)}</td>
                  <td style="text-align: right; color: var(--text-muted);">${w.maidens ?? 0}</td>
                  <td style="text-align: right;">${w.runs ?? w.runsConceded ?? 0}</td>
                  <td style="text-align: right; font-weight: 700; color: var(--accent-crimson);">${w.wickets ?? 0}</td>
                  <td style="text-align: right; font-family: var(--font-mono);">${w.economy ?? (w.overs > 0 ? (w.runs / w.overs).toFixed(2) : "0.00")}</td>
                </tr>
              `).join("") : `
                <tr><td colspan="6" style="text-align: center; color: var(--text-muted); padding: 12px;">No bowling figures recorded</td></tr>
              `}
            </tbody>
          </table>
        </div>
      `;
    }

    modalBody.innerHTML = html;
  } catch (err) {
    modalBody.innerHTML = `<div class="loading-state"><p>Failed to load scorecard: ${err.message}</p></div>`;
  }
}

// -----------------------------------------------------------------------------
// TAB 3: Players & Advanced Stats Filters
// -----------------------------------------------------------------------------
function initPlayerSearchDebounce() {
  const searchInput = document.getElementById("playerSearchInput");
  let timer;
  searchInput.addEventListener("input", (e) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      state.playerSearchQuery = e.target.value;
      state.playersPage = 1;
      loadPlayers();
    }, 300);
  });
}

function applyPlayerFilters() {
  state.playerCountryFilter = document.getElementById("countrySelect").value;
  state.playerRoleFilter = document.getElementById("roleSelect").value;
  state.playerTierFilter = document.getElementById("tierSelect").value;
  state.playerTraitFilter = document.getElementById("traitSelect").value;
  state.playerBowlingStyleFilter = document.getElementById("bowlingStyleSelect").value;
  state.playerBattingStyleFilter = document.getElementById("battingStyleSelect").value;
  state.playerSortBy = document.getElementById("sortSelect").value;
  state.playersPage = 1;
  loadPlayers();
}

function resetPlayerFilters() {
  document.getElementById("playerSearchInput").value = "";
  document.getElementById("countrySelect").value = "All";
  document.getElementById("roleSelect").value = "All";
  document.getElementById("tierSelect").value = "All";
  document.getElementById("traitSelect").value = "All";
  document.getElementById("bowlingStyleSelect").value = "All";
  document.getElementById("battingStyleSelect").value = "All";
  document.getElementById("sortSelect").value = "overall";

  state.playerSearchQuery = "";
  state.playerCountryFilter = "All";
  state.playerRoleFilter = "All";
  state.playerTierFilter = "All";
  state.playerTraitFilter = "All";
  state.playerBowlingStyleFilter = "All";
  state.playerBattingStyleFilter = "All";
  state.playerSortBy = "overall";
  state.playersPage = 1;

  loadPlayers();
}

async function loadPlayers() {
  const grid = document.getElementById("playersGrid");
  grid.innerHTML = `<div class="loading-state" style="grid-column: 1 / -1;"><div class="spinner"></div><p>Searching player database...</p></div>`;

  try {
    const params = new URLSearchParams({
      page: state.playersPage,
      limit: 36,
      sort: state.playerSortBy,
    });
    if (state.playerSearchQuery) params.append("search", state.playerSearchQuery);
    if (state.playerCountryFilter !== "All") params.append("country", state.playerCountryFilter);
    if (state.playerRoleFilter !== "All") params.append("role", state.playerRoleFilter);
    if (state.playerTierFilter !== "All") params.append("tier", state.playerTierFilter);
    if (state.playerTraitFilter !== "All") params.append("trait", state.playerTraitFilter);
    if (state.playerBowlingStyleFilter !== "All") params.append("bowlingStyle", state.playerBowlingStyleFilter);
    if (state.playerBattingStyleFilter !== "All") params.append("battingStyle", state.playerBattingStyleFilter);

    const res = await apiFetch(`/api/players?${params.toString()}`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`HTTP error ${res.status}`);
    const data = await res.json();
    if (!data.success) throw new Error(data.error);

    state.playersTotalPages = data.totalPages || 1;
    renderPlayers(data.players || []);
    renderPagination(data.page, data.totalPages);
  } catch (err) {
    console.error("Error loading players:", err);
    grid.innerHTML = `<div class="loading-state" style="grid-column: 1 / -1;"><p>Failed to load players: ${err.message}</p></div>`;
  }
}

function renderPlayers(players) {
  const grid = document.getElementById("playersGrid");
  if (!players || players.length === 0) {
    grid.innerHTML = `
      <div style="grid-column: 1 / -1; text-align: center; padding: 48px; color: var(--text-muted);">
        No players found matching your criteria. Try adjusting the search query or filters.
      </div>
    `;
    return;
  }

  grid.innerHTML = players.map((p) => {
    const formattedArch = (p.archetype || "").replace(/_/g, " ").toUpperCase();
    const traits = Object.entries(p.traits || {})
      .filter(([_, val]) => !!val)
      .map(([k]) => k.replace(/([A-Z])/g, " $1").trim())
      .slice(0, 3);

    return `
      <div class="player-card" onclick="openPlayerModal(${p.id})">
        <div class="player-card-header">
          <div class="player-name-col">
            <span class="player-card-name">${p.name}</span>
            <span class="player-card-nation">${p.country} • Age ${p.age}</span>
          </div>
          <div class="overall-rating-badge">
            <span class="rating-num">${p.overallRating}</span>
            <span class="rating-lbl">OVR</span>
          </div>
        </div>

        <div class="player-role-row">
          <span class="archetype-tag">${formattedArch}</span>
          ${p.isWicketKeeper ? '<span class="archetype-tag" style="color: var(--accent-gold); border-color: rgba(255,210,20,0.3);">🧤 WK</span>' : ""}
        </div>

        <div class="player-ratings-bar-row">
          <div class="rating-metric">
            <span class="metric-name">Batting</span>
            <span class="metric-val">${p.battingRating}</span>
          </div>
          <div class="rating-metric">
            <span class="metric-name">Bowling</span>
            <span class="metric-val">${p.bowlingRating}</span>
          </div>
          <div class="rating-metric">
            <span class="metric-name">Fielding</span>
            <span class="metric-val">${p.fieldingRating}</span>
          </div>
          <div class="rating-metric">
            <span class="metric-name">Captaincy</span>
            <span class="metric-val">${p.captaincyRating}</span>
          </div>
        </div>

        ${traits.length > 0 ? `
          <div class="player-traits-row">
            ${traits.map(t => `<span class="trait-chip">${t}</span>`).join("")}
          </div>
        ` : ""}

        <div style="margin-top: 6px; padding-top: 8px; border-top: 1px solid rgba(255,255,255,0.04); display: flex; justify-content: space-between; font-size: 12px; color: var(--text-muted);">
          <span>Mat: <strong style="color: #fff;">${p.stats.matches}</strong></span>
          <span>Runs: <strong style="color: #fff;">${p.stats.runs.toLocaleString()}</strong> (${p.stats.hundreds}x100)</span>
          <span>Wkts: <strong style="color: #fff;">${p.stats.wickets}</strong></span>
        </div>
      </div>
    `;
  }).join("");
}

function renderPagination(currentPage, totalPages) {
  const container = document.getElementById("playersPagination");
  if (totalPages <= 1) {
    container.innerHTML = "";
    return;
  }

  let html = "";
  if (currentPage > 1) {
    html += `<button class="page-btn" onclick="goToPlayerPage(${currentPage - 1})">« Prev</button>`;
  }

  const start = Math.max(1, currentPage - 2);
  const end = Math.min(totalPages, currentPage + 2);

  for (let i = start; i <= end; i++) {
    html += `<button class="page-btn ${i === currentPage ? "active" : ""}" onclick="goToPlayerPage(${i})">${i}</button>`;
  }

  if (currentPage < totalPages) {
    html += `<button class="page-btn" onclick="goToPlayerPage(${currentPage + 1})">Next »</button>`;
  }

  container.innerHTML = html;
}

function goToPlayerPage(p) {
  state.playersPage = p;
  loadPlayers();
  window.scrollTo({ top: 300, behavior: "smooth" });
}

// -----------------------------------------------------------------------------
// TAB 4: Player Comparison Tool (Head to Head)
// -----------------------------------------------------------------------------
function initCompareAutocomplete() {
  setupAutocomplete("compareP1Input", "compareP1Dropdown", (name) => {
    state.compareP1 = name;
  });
  setupAutocomplete("compareP2Input", "compareP2Dropdown", (name) => {
    state.compareP2 = name;
  });
}

function setupAutocomplete(inputId, dropdownId, onSelect) {
  const input = document.getElementById(inputId);
  const dropdown = document.getElementById(dropdownId);
  let debounce;

  input.addEventListener("input", (e) => {
    clearTimeout(debounce);
    const q = e.target.value.trim();
    if (q.length < 2) {
      dropdown.classList.add("hidden");
      dropdown.innerHTML = "";
      return;
    }

    debounce = setTimeout(async () => {
      try {
        const res = await apiFetch(`/api/players?search=${encodeURIComponent(q)}&limit=6`);
        const data = await res.json();
        if (data.success && data.players.length > 0) {
          dropdown.innerHTML = data.players.map(p => `
            <div class="autocomplete-item" onclick="selectAutocomplete('${inputId}', '${dropdownId}', '${p.name.replace(/'/g, "\\'")}')">
              <span class="item-name">${p.name}</span>
              <span class="item-meta">${p.country} • ${p.overallRating} OVR</span>
            </div>
          `).join("");
          dropdown.classList.remove("hidden");
        } else {
          dropdown.classList.add("hidden");
        }
      } catch {
        dropdown.classList.add("hidden");
      }
    }, 250);
  });

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      dropdown.classList.add("hidden");
      runPlayerComparison();
    }
  });

  document.addEventListener("click", (e) => {
    if (!input.contains(e.target) && !dropdown.contains(e.target)) {
      dropdown.classList.add("hidden");
    }
  });
}

function selectAutocomplete(inputId, dropdownId, name) {
  const input = document.getElementById(inputId);
  input.value = name;
  document.getElementById(dropdownId).classList.add("hidden");
  if (inputId === "compareP1Input") state.compareP1 = name;
  if (inputId === "compareP2Input") state.compareP2 = name;
}

function setCompareFormat(fmt) {
  state.compareFormat = fmt;
  document.querySelectorAll(".compare-format-pills .format-pill").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.format === fmt);
  });
  if (state.compareP1 && state.compareP2) {
    runPlayerComparison();
  }
}

function quickCompare(p1, p2) {
  document.getElementById("compareP1Input").value = p1;
  document.getElementById("compareP2Input").value = p2;
  state.compareP1 = p1;
  state.compareP2 = p2;
  runPlayerComparison();
}

async function runPlayerComparison() {
  const p1Val = document.getElementById("compareP1Input").value.trim();
  const p2Val = document.getElementById("compareP2Input").value.trim();
  const container = document.getElementById("compareResultsContainer");

  if (!p1Val || !p2Val) {
    container.innerHTML = `
      <div class="compare-placeholder-card">
        <div class="placeholder-icon">⚠️</div>
        <div class="placeholder-title">Please enter both players</div>
        <div class="placeholder-desc">Type names for both Player 1 and Player 2 to launch head-to-head comparison.</div>
      </div>
    `;
    return;
  }

  state.compareP1 = p1Val;
  state.compareP2 = p2Val;

  container.innerHTML = `
    <div class="loading-state">
      <div class="spinner"></div>
      <p>Simulating head-to-head statistical breakdown for ${p1Val} vs ${p2Val}...</p>
    </div>
  `;

  try {
    const url = `/api/players/compare?p1=${encodeURIComponent(p1Val)}&p2=${encodeURIComponent(p2Val)}&format=${state.compareFormat}`;
    const res = await apiFetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`HTTP error ${res.status}`);
    const data = await res.json();
    if (!data.success) throw new Error(data.error);

    renderComparisonCard(data);
  } catch (err) {
    container.innerHTML = `
      <div class="compare-placeholder-card">
        <div class="placeholder-icon">❌</div>
        <div class="placeholder-title">Comparison Failed</div>
        <div class="placeholder-desc">${err.message || "Could not find one or both players. Please verify the spellings."}</div>
      </div>
    `;
  }
}

function renderComparisonCard(data) {
  const container = document.getElementById("compareResultsContainer");
  const p1 = data.player1;
  const p2 = data.player2;
  const verdictText = (data.comparison && data.comparison.verdict) || `${p1.name} vs ${p2.name}`;
  const formatLabelText = data.formatLabel || (data.format ? data.format.toUpperCase() : "All Formats");

  // Build stat bar comparison helper
  const renderStatRow = (label, p1Val, p2Val, isHigherBetter = true, suffix = "") => {
    const num1 = typeof p1Val === "number" ? p1Val : parseFloat(p1Val) || 0;
    const num2 = typeof p2Val === "number" ? p2Val : parseFloat(p2Val) || 0;
    const total = num1 + num2 || 1;
    const p1Pct = Math.min(100, Math.max(0, (num1 / total) * 100));
    const p2Pct = Math.min(100, Math.max(0, (num2 / total) * 100));

    let p1Adv = false;
    let p2Adv = false;
    if (num1 !== num2) {
      if (isHigherBetter) {
        p1Adv = num1 > num2;
        p2Adv = num2 > num1;
      } else {
        // Lower is better (e.g. economy)
        p1Adv = num1 < num2 && num1 > 0;
        p2Adv = num2 < num1 && num2 > 0;
      }
    }

    return `
      <div class="stat-comparison-row">
        <div class="stat-val-cell p1 ${p1Adv ? "advantage" : ""}">
          ${p1Adv ? '<span class="advantage-crown">👑</span>' : ""}
          <span>${p1Val}${suffix}</span>
        </div>
        <div class="stat-bar-track">
          <div class="stat-bar-fill p1" style="width: ${p1Pct}%;"></div>
        </div>
        <div class="stat-metric-label">${label}</div>
        <div class="stat-bar-track">
          <div class="stat-bar-fill p2" style="width: ${p2Pct}%;"></div>
        </div>
        <div class="stat-val-cell p2 ${p2Adv ? "advantage" : ""}">
          <span>${p2Val}${suffix}</span>
          ${p2Adv ? '<span class="advantage-crown">👑</span>' : ""}
        </div>
      </div>
    `;
  };

  const p1Initials = p1.name.split(" ").map(w => w[0]).join("").slice(0, 2);
  const p2Initials = p2.name.split(" ").map(w => w[0]).join("").slice(0, 2);

  // Traits arrays
  const p1Traits = Object.entries(p1.traits || {}).filter(([_, v]) => !!v).map(([k]) => k.replace(/([A-Z])/g, " $1").trim());
  const p2Traits = Object.entries(p2.traits || {}).filter(([_, v]) => !!v).map(([k]) => k.replace(/([A-Z])/g, " $1").trim());

  container.innerHTML = `
    <div class="head-to-head-card">
      <div class="h2h-header-grid">
        <div class="h2h-player-profile">
          <div class="h2h-avatar-shield p1">${p1Initials}</div>
          <div>
            <div class="h2h-player-name" onclick="openPlayerModal(${p1.id})">${p1.name}</div>
            <div class="h2h-player-sub">${p1.nationality} • ${(p1.archetype || "").replace(/_/g, " ").toUpperCase()} • Age ${p1.age}</div>
            <div style="font-size: 12px; color: var(--accent-cyan); margin-top: 2px;">
              ${(p1.battingStyle || "").replace(/_/g, " ")} | ${(p1.bowlingStyle || "").replace(/_/g, " ")}
            </div>
          </div>
        </div>

        <div class="h2h-center-divider">
          <div class="vs-circle" style="width: 40px; height: 40px; font-size: 14px;">VS</div>
          <span class="h2h-format-badge">${formatLabelText}</span>
        </div>

        <div class="h2h-player-profile right-player">
          <div class="h2h-avatar-shield p2">${p2Initials}</div>
          <div>
            <div class="h2h-player-name" onclick="openPlayerModal(${p2.id})">${p2.name}</div>
            <div class="h2h-player-sub">${p2.nationality} • ${(p2.archetype || "").replace(/_/g, " ").toUpperCase()} • Age ${p2.age}</div>
            <div style="font-size: 12px; color: var(--accent-gold); margin-top: 2px;">
              ${(p2.battingStyle || "").replace(/_/g, " ")} | ${(p2.bowlingStyle || "").replace(/_/g, " ")}
            </div>
          </div>
        </div>
      </div>

      <div class="h2h-verdict-banner">
        <span>⚔️ <strong>Verdict:</strong> ${verdictText}</span>
      </div>

      <div class="h2h-stats-section">
        <div class="h2h-section-heading">Core Player Ratings</div>
        ${renderStatRow("Overall Rating", p1.overallRating, p2.overallRating)}
        ${renderStatRow("Batting Rating", p1.battingRating, p2.battingRating)}
        ${renderStatRow("Bowling Rating", p1.bowlingRating, p2.bowlingRating)}
        ${renderStatRow("Fielding Rating", p1.fieldingRating, p2.fieldingRating)}
        ${renderStatRow("Captaincy Rating", p1.captaincyRating, p2.captaincyRating)}

        <div class="h2h-section-heading" style="margin-top: 24px;">Batting Performance (${formatLabelText})</div>
        ${renderStatRow("Matches", p1.stats.matches, p2.stats.matches)}
        ${renderStatRow("Runs", p1.stats.runs, p2.stats.runs)}
        ${renderStatRow("Batting Average", p1.stats.battingAvg, p2.stats.battingAvg)}
        ${renderStatRow("Strike Rate", p1.stats.strikeRate, p2.stats.strikeRate)}
        ${renderStatRow("Centuries (100s)", p1.stats.hundreds, p2.stats.hundreds)}
        ${renderStatRow("Fifties (50s)", p1.stats.fifties, p2.stats.fifties)}
        ${renderStatRow("Highest Score", p1.stats.highestScore, p2.stats.highestScore)}

        <div class="h2h-section-heading" style="margin-top: 24px;">Bowling Performance (${formatLabelText})</div>
        ${renderStatRow("Wickets", p1.stats.wickets, p2.stats.wickets)}
        ${renderStatRow("Economy", p1.stats.economy, p2.stats.economy, false)}
        ${renderStatRow("Overs Bowled", formatCricketOvers(p1.stats.oversBowled), formatCricketOvers(p2.stats.oversBowled))}
        ${renderStatRow("Best Figures", p1.stats.bestBowling, p2.stats.bestBowling)}

        <div class="h2h-section-heading" style="margin-top: 24px;">Special Traits & Clutch Ability</div>
        <div class="traits-comparison-grid">
          <div class="traits-box">
            <div class="traits-box-title">🌟 ${p1.name}'s Traits</div>
            <div class="trait-list-pills">
              ${p1Traits.length > 0 ? p1Traits.map(t => `<span class="trait-chip">${t}</span>`).join("") : '<span style="color: var(--text-muted); font-size: 13px;">No special traits assigned</span>'}
            </div>
          </div>
          <div class="traits-box">
            <div class="traits-box-title">🌟 ${p2.name}'s Traits</div>
            <div class="trait-list-pills">
              ${p2Traits.length > 0 ? p2Traits.map(t => `<span class="trait-chip">${t}</span>`).join("") : '<span style="color: var(--text-muted); font-size: 13px;">No special traits assigned</span>'}
            </div>
          </div>
        </div>
      </div>
    </div>
  `;
}

// -----------------------------------------------------------------------------
// TAB 5: Rankings & Leaderboards (International / Domestic / Overall)
// -----------------------------------------------------------------------------
function renderFormatPills(scope = state.rankingsScope) {
  const pillsContainer = document.getElementById("rankingsFormatPills");
  if (!pillsContainer) return;
  const teamsSubtab = document.getElementById("teamsRankingSubtab");

  if (scope === "international") {
    if (teamsSubtab) teamsSubtab.style.display = "inline-flex";
    if (!["odi", "t20", "test"].includes(state.rankingsFormat)) {
      state.rankingsFormat = "odi";
    }
    pillsContainer.innerHTML = `
      <span class="format-filter-lbl">Format:</span>
      <button class="format-pill-btn ${state.rankingsFormat === 'odi' ? 'active' : ''}" onclick="setRankingsFormat('odi')">ODI (50-Over)</button>
      <button class="format-pill-btn ${state.rankingsFormat === 't20' ? 'active' : ''}" onclick="setRankingsFormat('t20')">T20 International</button>
      <button class="format-pill-btn ${state.rankingsFormat === 'test' ? 'active' : ''}" onclick="setRankingsFormat('test')">Test Championship</button>
    `;
  } else if (scope === "domestic") {
    if (teamsSubtab) teamsSubtab.style.display = "none";
    if (state.activeRankingCategory === "teams") state.activeRankingCategory = "batting";
    if (!["t20", "list_a", "first_class"].includes(state.rankingsFormat)) {
      state.rankingsFormat = "t20";
    }
    pillsContainer.innerHTML = `
      <span class="format-filter-lbl">Format:</span>
      <button class="format-pill-btn ${state.rankingsFormat === 't20' ? 'active' : ''}" onclick="setRankingsFormat('t20')">⚡ T20 Leagues</button>
      <button class="format-pill-btn ${state.rankingsFormat === 'list_a' ? 'active' : ''}" onclick="setRankingsFormat('list_a')">🏏 List-A</button>
      <button class="format-pill-btn ${state.rankingsFormat === 'first_class' ? 'active' : ''}" onclick="setRankingsFormat('first_class')">🏛️ First-Class</button>
    `;
  } else {
    // Overall
    if (teamsSubtab) teamsSubtab.style.display = "none";
    if (state.activeRankingCategory === "teams") state.activeRankingCategory = "batting";
    state.rankingsFormat = "all";
    pillsContainer.innerHTML = `
      <span class="format-filter-lbl">Format:</span>
      <button class="format-pill-btn active" style="cursor: default;">🌐 All Formats Combined</button>
    `;
  }
}

function setRankingsScope(scope) {
  state.rankingsScope = scope;
  document.querySelectorAll(".scope-tab-btn").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.scope === scope);
  });

  if (scope === "international") {
    state.rankingsFormat = "odi";
  } else if (scope === "domestic") {
    state.rankingsFormat = "t20";
  } else {
    state.rankingsFormat = "all";
  }

  renderFormatPills(scope);
  loadRankings();
}

function setRankingsFormat(fmt) {
  state.rankingsFormat = fmt;
  renderFormatPills(state.rankingsScope);
  loadRankings();
}

async function loadRankings() {
  renderFormatPills(state.rankingsScope);
  const tbody = document.getElementById("rankingsTableBody");
  tbody.innerHTML = `<tr><td colspan="10" class="loading-cell"><div class="spinner" style="margin: 12px auto;"></div>Fetching rankings snapshot & leaderboards...</td></tr>`;

  try {
    let url = `/api/rankings?scope=${state.rankingsScope}&format=${state.rankingsFormat}`;
    const res = await apiFetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`HTTP error ${res.status}`);
    const data = await res.json();
    if (!data.success) throw new Error(data.error);

    state.rankingsData = data;

    // Render Caps if available
    renderCaps(data.leaderboards || {});

    // Render current active category or leaderboard
    renderCurrentRankingsOrLeaderboard();
  } catch (err) {
    console.error("Error loading rankings:", err);
    tbody.innerHTML = `<tr><td colspan="10" style="text-align: center; padding: 24px; color: var(--accent-crimson);">Failed to load rankings: ${err.message}</td></tr>`;
  }
}

function renderCaps(leaderboards) {
  const orange = document.getElementById("orangeCapList");
  const purple = document.getElementById("purpleCapList");
  const orangeSub = document.getElementById("orangeCapSubtitle");
  const purpleSub = document.getElementById("purpleCapSubtitle");

  const fmtLabel = state.rankingsScope === "overall" ? "Universe" : `${state.rankingsScope.toUpperCase()} ${state.rankingsFormat.toUpperCase()}`;
  if (orangeSub) orangeSub.textContent = `Leading Run Scorers (${fmtLabel})`;
  if (purpleSub) purpleSub.textContent = `Leading Wicket Takers (${fmtLabel})`;

  if (leaderboards && leaderboards.orangeCap && leaderboards.orangeCap.length > 0) {
    orange.innerHTML = leaderboards.orangeCap.map((c, idx) => {
      let medal = idx === 0 ? "🥇" : idx === 1 ? "🥈" : idx === 2 ? "🥉" : `#${idx + 1}`;
      return `
        <div class="cap-leader-row" onclick="openPlayerModal(${c.id})" style="cursor: pointer;" title="Click to view player profile">
          <span class="cap-rank-num">${medal}</span>
          <span class="cap-player-name">${c.name}</span>
          <span class="cap-player-team">${c.country}</span>
          <span class="cap-score-stat">
            ${c.runs.toLocaleString()} Runs
            <span class="cap-extra">(${c.hundreds}x100, ${c.fifties}x50, Avg: ${c.battingAvg || '-'})</span>
          </span>
        </div>
      `;
    }).join("");
  } else {
    orange.innerHTML = `<div style="padding: 12px; color: var(--text-muted); font-size: 13px;">Leading run records updated with each tournament match.</div>`;
  }

  if (leaderboards && leaderboards.purpleCap && leaderboards.purpleCap.length > 0) {
    purple.innerHTML = leaderboards.purpleCap.map((c, idx) => {
      let medal = idx === 0 ? "🥇" : idx === 1 ? "🥈" : idx === 2 ? "🥉" : `#${idx + 1}`;
      return `
        <div class="cap-leader-row" onclick="openPlayerModal(${c.id})" style="cursor: pointer;" title="Click to view player profile">
          <span class="cap-rank-num">${medal}</span>
          <span class="cap-player-name">${c.name}</span>
          <span class="cap-player-team">${c.country}</span>
          <span class="cap-score-stat">
            ${c.wickets} Wickets
            <span class="cap-extra">(Econ: ${c.economy || '-'}, Avg: ${c.bowlingAvg || '-'})</span>
          </span>
        </div>
      `;
    }).join("");
  } else {
    purple.innerHTML = `<div style="padding: 12px; color: var(--text-muted); font-size: 13px;">Leading wicket records updated with each tournament match.</div>`;
  }
}

function setRankingsMode(mode) {
  state.rankingsMode = mode;
  const btnR = document.getElementById("modeBtnRankings");
  const btnLb = document.getElementById("modeBtnLeaderboards");
  if (btnR) btnR.classList.toggle("active", mode === "rankings");
  if (btnLb) btnLb.classList.toggle("active", mode === "leaderboards");

  const rSubtabs = document.getElementById("rankingsSubtabsBar");
  const lbSubtabs = document.getElementById("leaderboardSubtabsBar");
  if (rSubtabs) {
    if (mode === "rankings") rSubtabs.classList.remove("hidden");
    else rSubtabs.classList.add("hidden");
  }
  if (lbSubtabs) {
    if (mode === "leaderboards") lbSubtabs.classList.remove("hidden");
    else lbSubtabs.classList.add("hidden");
  }

  if (mode === "rankings") {
    document.querySelectorAll("#rankingsSubtabsBar .subtab-btn").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.cat === state.activeRankingCategory);
    });
  } else {
    document.querySelectorAll("#leaderboardSubtabsBar .subtab-btn").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.lbcat === state.activeLeaderboardCategory);
    });
  }

  renderCurrentRankingsOrLeaderboard();
}

function switchRankingCategory(category) {
  state.rankingsMode = "rankings";
  state.activeRankingCategory = category;

  const btnR = document.getElementById("modeBtnRankings");
  const btnLb = document.getElementById("modeBtnLeaderboards");
  if (btnR) btnR.classList.add("active");
  if (btnLb) btnLb.classList.remove("active");

  const rSubtabs = document.getElementById("rankingsSubtabsBar");
  const lbSubtabs = document.getElementById("leaderboardSubtabsBar");
  if (rSubtabs) rSubtabs.classList.remove("hidden");
  if (lbSubtabs) lbSubtabs.classList.add("hidden");

  document.querySelectorAll("#rankingsSubtabsBar .subtab-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.cat === category);
  });
  renderCurrentRankingsOrLeaderboard();
}

function switchLeaderboardCategory(cat) {
  state.rankingsMode = "leaderboards";
  state.activeLeaderboardCategory = cat;

  const btnR = document.getElementById("modeBtnRankings");
  const btnLb = document.getElementById("modeBtnLeaderboards");
  if (btnR) btnR.classList.remove("active");
  if (btnLb) btnLb.classList.add("active");

  const rSubtabs = document.getElementById("rankingsSubtabsBar");
  const lbSubtabs = document.getElementById("leaderboardSubtabsBar");
  if (rSubtabs) rSubtabs.classList.add("hidden");
  if (lbSubtabs) lbSubtabs.classList.remove("hidden");

  document.querySelectorAll("#leaderboardSubtabsBar .subtab-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.lbcat === cat);
  });
  renderCurrentRankingsOrLeaderboard();
}

function renderCurrentRankingsOrLeaderboard() {
  if (!state.rankingsData) return;
  if (state.rankingsMode === "leaderboards") {
    renderLeaderboardTable(state.rankingsData.leaderboards || {});
  } else {
    renderRankingTable(state.rankingsData.rankings ? (state.rankingsData.rankings[state.activeRankingCategory] || []) : []);
  }
}

function renderRankingTable(items) {
  const thead = document.getElementById("rankingsTableHead");
  const tbody = document.getElementById("rankingsTableBody");

  if (thead) {
    thead.innerHTML = `
      <tr>
        <th style="width: 70px;">Rank</th>
        <th>Player / Team</th>
        <th>Nation / Affiliation</th>
        <th style="text-align: right;">Rating Points</th>
        <th style="text-align: right;">Key Statistics</th>
      </tr>
    `;
  }

  if (!items || items.length === 0) {
    tbody.innerHTML = `<tr><td colspan="5" style="text-align: center; padding: 32px; color: var(--text-muted);">No snapshot records in this category for the selected scope.</td></tr>`;
    return;
  }

  tbody.innerHTML = items.map((r) => {
    let rankBadgeClass = "rank-badge-cell";
    let medal = "";
    if (r.rank === 1) { rankBadgeClass += " gold"; medal = "🥇 "; }
    else if (r.rank === 2) { rankBadgeClass += " silver"; medal = "🥈 "; }
    else if (r.rank === 3) { rankBadgeClass += " bronze"; medal = "🥉 "; }

    const isClickable = r.id && !isNaN(Number(r.id));
    const nameHtml = isClickable
      ? `<td class="rank-entity-name" onclick="openPlayerModal(${r.id})" style="cursor: pointer; color: var(--accent-gold); font-weight: 600;">${r.name}</td>`
      : `<td class="rank-entity-name">${r.name}</td>`;

    return `
      <tr>
        <td class="${rankBadgeClass}">${medal}#${r.rank}</td>
        ${nameHtml}
        <td style="color: var(--text-muted);">${r.team || "-"}</td>
        <td class="rank-rating-cell">${r.rating}</td>
        <td class="rank-stat-cell">${r.stat || "-"}</td>
      </tr>
    `;
  }).join("");
}

function renderLeaderboardTable(leaderboards) {
  const thead = document.getElementById("rankingsTableHead");
  const tbody = document.getElementById("rankingsTableBody");
  const cat = state.activeLeaderboardCategory || "mostRuns";

  if (cat === "mostRuns") {
    if (thead) {
      thead.innerHTML = `
        <tr>
          <th style="width: 70px;">Rank</th>
          <th>Batter</th>
          <th>Nation</th>
          <th style="text-align: right; color: var(--accent-gold);">Rating</th>
          <th style="text-align: right;">Mat / Inn</th>
          <th style="text-align: right; color: #ff9100;">Total Runs</th>
          <th style="text-align: right;">HS</th>
          <th style="text-align: right;">Average</th>
          <th style="text-align: right;">Strike Rate</th>
          <th style="text-align: right;">100s / 50s</th>
        </tr>
      `;
    }
    const rows = leaderboards.mostRuns || [];
    if (rows.length === 0) {
      tbody.innerHTML = `<tr><td colspan="10" style="text-align: center; padding: 32px; color: var(--text-muted);">No run leader records found.</td></tr>`;
      return;
    }
    tbody.innerHTML = rows.map((r) => {
      let medal = r.rank === 1 ? "🥇 " : r.rank === 2 ? "🥈 " : r.rank === 3 ? "🥉 " : "";
      return `
        <tr>
          <td class="rank-badge-cell ${r.rank <= 3 ? 'gold' : ''}">${medal}#${r.rank}</td>
          <td class="rank-entity-name" onclick="openPlayerModal(${r.id})" style="cursor: pointer; color: var(--accent-gold);">${r.name}</td>
          <td style="color: var(--text-muted);">${r.country || "-"}</td>
          <td style="text-align: right; font-weight: 700; color: var(--accent-gold); font-family: var(--font-heading);">${r.rating || "-"}</td>
          <td style="text-align: right;">${r.matches} / ${r.innings}</td>
          <td style="text-align: right; font-weight: 700; color: #ff9100; font-family: var(--font-heading); font-size: 15px;">${r.runs.toLocaleString()}</td>
          <td style="text-align: right;">${r.highestScore}</td>
          <td style="text-align: right; color: var(--accent-green); font-weight: 600;">${r.battingAvg}</td>
          <td style="text-align: right;">${r.strikeRate}</td>
          <td style="text-align: right;">${r.hundreds} / ${r.fifties}</td>
        </tr>
      `;
    }).join("");
  } else if (cat === "mostWickets") {
    if (thead) {
      thead.innerHTML = `
        <tr>
          <th style="width: 70px;">Rank</th>
          <th>Bowler</th>
          <th>Nation</th>
          <th style="text-align: right; color: #c084fc;">Rating</th>
          <th style="text-align: right;">Matches</th>
          <th style="text-align: right; color: #c084fc;">Wickets</th>
          <th style="text-align: right;">Overs</th>
          <th style="text-align: right;">Runs Conceded</th>
          <th style="text-align: right;">Economy</th>
          <th style="text-align: right;">Bowling Avg</th>
          <th style="text-align: right;">Best Bowling</th>
        </tr>
      `;
    }
    const rows = leaderboards.mostWickets || [];
    if (rows.length === 0) {
      tbody.innerHTML = `<tr><td colspan="11" style="text-align: center; padding: 32px; color: var(--text-muted);">No wicket leader records found.</td></tr>`;
      return;
    }
    tbody.innerHTML = rows.map((r) => {
      let medal = r.rank === 1 ? "🥇 " : r.rank === 2 ? "🥈 " : r.rank === 3 ? "🥉 " : "";
      return `
        <tr>
          <td class="rank-badge-cell ${r.rank <= 3 ? 'gold' : ''}">${medal}#${r.rank}</td>
          <td class="rank-entity-name" onclick="openPlayerModal(${r.id})" style="cursor: pointer; color: var(--accent-purple);">${r.name}</td>
          <td style="color: var(--text-muted);">${r.country || "-"}</td>
          <td style="text-align: right; font-weight: 700; color: #c084fc; font-family: var(--font-heading);">${r.rating || "-"}</td>
          <td style="text-align: right;">${r.matches}</td>
          <td style="text-align: right; font-weight: 700; color: #c084fc; font-family: var(--font-heading); font-size: 15px;">${r.wickets}</td>
          <td style="text-align: right;">${r.overs}</td>
          <td style="text-align: right;">${r.runsConceded}</td>
          <td style="text-align: right; color: var(--accent-green); font-weight: 600;">${r.economy}</td>
          <td style="text-align: right;">${r.bowlingAvg}</td>
          <td style="text-align: right; font-weight: 600;">${r.bestBowling || "-"}</td>
        </tr>
      `;
    }).join("");
  } else if (cat === "highestScores") {
    if (thead) {
      thead.innerHTML = `
        <tr>
          <th style="width: 70px;">Rank</th>
          <th>Batter</th>
          <th>Nation</th>
          <th style="text-align: right; color: var(--accent-gold);">Rating</th>
          <th style="text-align: right; color: var(--accent-gold);">Highest Score</th>
          <th style="text-align: right;">Career Runs</th>
          <th style="text-align: right;">Centuries / Fifties</th>
          <th style="text-align: right;">Matches</th>
        </tr>
      `;
    }
    const rows = leaderboards.highestScores || [];
    if (rows.length === 0) {
      tbody.innerHTML = `<tr><td colspan="8" style="text-align: center; padding: 32px; color: var(--text-muted);">No records found.</td></tr>`;
      return;
    }
    tbody.innerHTML = rows.map((r) => {
      let medal = r.rank === 1 ? "🥇 " : r.rank === 2 ? "🥈 " : r.rank === 3 ? "🥉 " : "";
      return `
        <tr>
          <td class="rank-badge-cell ${r.rank <= 3 ? 'gold' : ''}">${medal}#${r.rank}</td>
          <td class="rank-entity-name" onclick="openPlayerModal(${r.id})" style="cursor: pointer; color: var(--accent-gold);">${r.name}</td>
          <td style="color: var(--text-muted);">${r.country || "-"}</td>
          <td style="text-align: right; font-weight: 700; color: var(--accent-gold); font-family: var(--font-heading);">${r.rating || "-"}</td>
          <td style="text-align: right; font-weight: 700; color: #ff9100; font-family: var(--font-heading); font-size: 16px;">${r.score}</td>
          <td style="text-align: right;">${r.runs.toLocaleString()}</td>
          <td style="text-align: right;">${r.hundreds}x100, ${r.fifties}x50</td>
          <td style="text-align: right;">${r.matches}</td>
        </tr>
      `;
    }).join("");
  } else if (cat === "bestBowling") {
    if (thead) {
      thead.innerHTML = `
        <tr>
          <th style="width: 70px;">Rank</th>
          <th>Bowler</th>
          <th>Nation</th>
          <th style="text-align: right; color: var(--accent-purple);">Rating</th>
          <th style="text-align: right; color: var(--accent-purple);">Best Bowling Figures</th>
          <th style="text-align: right;">Career Wickets</th>
          <th style="text-align: right;">Matches</th>
        </tr>
      `;
    }
    const rows = leaderboards.bestBowling || [];
    if (rows.length === 0) {
      tbody.innerHTML = `<tr><td colspan="7" style="text-align: center; padding: 32px; color: var(--text-muted);">No records found.</td></tr>`;
      return;
    }
    tbody.innerHTML = rows.map((r) => {
      let medal = r.rank === 1 ? "🥇 " : r.rank === 2 ? "🥈 " : r.rank === 3 ? "🥉 " : "";
      return `
        <tr>
          <td class="rank-badge-cell ${r.rank <= 3 ? 'gold' : ''}">${medal}#${r.rank}</td>
          <td class="rank-entity-name" onclick="openPlayerModal(${r.id})" style="cursor: pointer; color: var(--accent-purple);">${r.name}</td>
          <td style="color: var(--text-muted);">${r.country || "-"}</td>
          <td style="text-align: right; font-weight: 700; color: #c084fc; font-family: var(--font-heading);">${r.rating || "-"}</td>
          <td style="text-align: right; font-weight: 700; color: #c084fc; font-family: var(--font-heading); font-size: 16px;">${r.bestBowling}</td>
          <td style="text-align: right;">${r.wickets}</td>
          <td style="text-align: right;">${r.matches}</td>
        </tr>
      `;
    }).join("");
  }
}

// -----------------------------------------------------------------------------
// TAB 6: Tournaments & Standings Hub
// -----------------------------------------------------------------------------
async function loadTournaments() {
  const selectBox = document.getElementById("tournamentSelectBox");
  try {
    const res = await apiFetch("/api/tournaments");
    const data = await res.json();
    if (!data.success) throw new Error(data.error);

    state.tournamentsList = data.tournaments || [];
    renderTournamentDropdownOptions();

    // Default select first tournament if none active
    if (!state.activeTournamentId && state.tournamentsList.length > 0) {
      state.activeTournamentId = state.tournamentsList[0].id;
    }

    if (state.activeTournamentId) {
      if (selectBox) selectBox.value = state.activeTournamentId;
      const found = state.tournamentsList.find(t => t.id === state.activeTournamentId);
      const searchInput = document.getElementById("tournamentSearchInput");
      if (searchInput && found) {
        searchInput.value = found.name;
      }
      loadTournamentDetails(state.activeTournamentId);
    }
  } catch (err) {
    console.error("Error loading tournaments:", err);
    document.getElementById("tourneySubViewContainer").innerHTML = `
      <div class="loading-state"><p>Failed to load tournaments: ${err.message}</p></div>
    `;
  }
}

function filterTournamentList(cat) {
  state.tournamentsFilterCat = cat;
  document.querySelectorAll(".cat-pill").forEach(btn => {
    btn.classList.toggle("active", btn.getAttribute("onclick")?.includes(`'${cat}'`));
  });
  renderTournamentDropdownOptions();

  // If active tournament is not in filtered list, select first available
  const selectBox = document.getElementById("tournamentSelectBox");
  if (selectBox && selectBox.options.length > 0 && selectBox.options[0].value) {
    const isStillPresent = state.tournamentsList.some(t => t.id === state.activeTournamentId && (cat === "all" || t.category === cat));
    if (!isStillPresent) {
      state.activeTournamentId = selectBox.options[0].value;
      selectBox.value = state.activeTournamentId;
      const found = state.tournamentsList.find(t => t.id === state.activeTournamentId);
      const searchInput = document.getElementById("tournamentSearchInput");
      if (searchInput && found) searchInput.value = found.name;
      loadTournamentDetails(state.activeTournamentId);
    }
  }
}

function renderTournamentDropdownOptions() {
  const selectBox = document.getElementById("tournamentSelectBox");
  if (!selectBox) return;

  const filtered = state.tournamentsFilterCat === "all"
    ? state.tournamentsList
    : state.tournamentsList.filter(t => t.category === state.tournamentsFilterCat);

  if (filtered.length === 0) {
    selectBox.innerHTML = `<option value="">No tournaments in this category</option>`;
    return;
  }

  selectBox.innerHTML = filtered.map(t => `
    <option value="${t.id}" ${t.id === state.activeTournamentId ? "selected" : ""}>
      ${t.name} (${t.id}) • Season ${t.season || 1} [${t.matchesCount} matches]
    </option>
  `).join("");
}

function onTournamentSelectChange() {
  const selectBox = document.getElementById("tournamentSelectBox");
  if (!selectBox) return;
  const tourneyId = selectBox.value;
  if (tourneyId) {
    selectTournament(tourneyId);
  }
}

function onTournamentSearchInput(query) {
  const dropdown = document.getElementById("tournamentSearchDropdown");
  const q = String(query || "").trim().toLowerCase();

  if (!dropdown) return;

  let matches = state.tournamentsList;
  if (state.tournamentsFilterCat !== "all") {
    matches = matches.filter(t => t.category === state.tournamentsFilterCat);
  }

  if (q) {
    matches = matches.filter(t =>
      (t.name && t.name.toLowerCase().includes(q)) ||
      (t.id && t.id.toLowerCase().includes(q)) ||
      (t.category && t.category.toLowerCase().includes(q))
    );
  }

  if (matches.length === 0) {
    dropdown.innerHTML = `<div style="padding: 12px 14px; color: var(--text-muted); font-size: 12px; text-align: center;">No tournaments found matching "${escapeHtml(q)}"</div>`;
    dropdown.classList.remove("hidden");
    return;
  }

  dropdown.innerHTML = matches.slice(0, 15).map(t => `
    <div class="tourney-search-item ${t.id === state.activeTournamentId ? 'active' : ''}" onclick="selectTournament('${t.id}')">
      <div class="tourney-search-item-info">
        <span class="tourney-search-item-title">${t.name}</span>
        <span class="tourney-search-item-sub">${(t.category || "").replace(/_/g, " ").toUpperCase()} • Season ${t.season || 1} • ${t.matchesCount || 0} Matches</span>
      </div>
      <span class="tourney-search-item-badge">${t.id}</span>
    </div>
  `).join("");
  dropdown.classList.remove("hidden");
}

function onTournamentSearchFocus() {
  const input = document.getElementById("tournamentSearchInput");
  onTournamentSearchInput(input ? input.value : "");
}

function selectTournament(tourneyId) {
  const dropdown = document.getElementById("tournamentSearchDropdown");
  if (dropdown) dropdown.classList.add("hidden");

  state.activeTournamentId = tourneyId;
  const selectBox = document.getElementById("tournamentSelectBox");
  if (selectBox) selectBox.value = tourneyId;

  const found = state.tournamentsList.find(t => t.id === tourneyId);
  const input = document.getElementById("tournamentSearchInput");
  if (input && found) {
    input.value = found.name;
  }

  loadTournamentDetails(tourneyId);
}

// Global click-outside listener to hide tournament search dropdown
document.addEventListener("click", (e) => {
  const searchWrap = document.querySelector(".tourney-search-wrap");
  const dropdown = document.getElementById("tournamentSearchDropdown");
  if (dropdown && searchWrap && !searchWrap.contains(e.target)) {
    dropdown.classList.add("hidden");
  }
});

async function loadTournamentDetails(tourneyId) {
  const container = document.getElementById("tourneySubViewContainer");
  const metaBadge = document.getElementById("selectedTournamentMeta");

  container.innerHTML = `
    <div class="loading-state">
      <div class="spinner"></div>
      <p>Loading tournament standings, statistics, and squads...</p>
    </div>
  `;

  try {
    const res = await apiFetch(`/api/tournaments/${tourneyId}`);
    const data = await res.json();
    if (!data.success) throw new Error(data.error);

    state.activeTournamentData = data;
    metaBadge.textContent = `${(data.tournament.type || "cricket").toUpperCase()} • ${data.matchesCount || 0} MATCHES PLAYED`;

    const found = state.tournamentsList.find(t => t.id === tourneyId);
    const searchInput = document.getElementById("tournamentSearchInput");
    if (searchInput && found && searchInput.value !== found.name) {
      searchInput.value = found.name;
    }

    // Smart default for active stage: if super stage exists and has played matches, default to stage2, else stage1
    if (data.hasSuperStage) {
      const hasSuperMatches = Array.isArray(data.superStageRows) && data.superStageRows.some(r => r.played > 0);
      state.tourneyActiveStage = hasSuperMatches ? "stage2" : "stage1";
    } else {
      state.tourneyActiveStage = "stage1";
    }

    renderTourneySubView();
  } catch (err) {
    container.innerHTML = `
      <div class="loading-state"><p>Failed to load tournament details: ${err.message}</p></div>
    `;
  }
}

function switchTourneyView(view) {
  state.activeTourneySubView = view;
  document.querySelectorAll(".tourney-subnav-btn").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.view === view);
  });
  renderTourneySubView();
}

function setTourneyStage(stage) {
  state.tourneyActiveStage = stage;
  renderTourneySubView();
}

function setTourneyGroup(group) {
  state.tourneyActiveGroup = group;
  renderTourneySubView();
}

function renderStandingsTable(rows, title = "", qualifyCount = 4) {
  if (!rows || rows.length === 0) {
    return `<div style="text-align: center; padding: 24px; color: var(--text-muted);">No standings data available.</div>`;
  }

  return `
    ${title ? `
      <div style="font-family: var(--font-heading); font-size: 15px; font-weight: 700; color: var(--accent-gold); margin: 14px 0 8px 0; display: flex; align-items: center; justify-content: space-between;">
        <span>${title}</span>
        <span style="font-size: 11px; color: var(--text-muted); font-weight: normal;">Top ${qualifyCount} qualify for next round</span>
      </div>
    ` : ""}
    <div style="overflow-x: auto; -webkit-overflow-scrolling: touch; margin-bottom: 20px; border-radius: var(--radius-md); border: 1px solid var(--border-subtle);">
      <table class="standings-table" style="min-width: 620px; width: 100%;">
        <thead>
          <tr>
            <th style="width: 50px;">Pos</th>
            <th>Team</th>
            <th style="text-align: center;">P</th>
            <th style="text-align: center;">W</th>
            <th style="text-align: center;">L</th>
            <th style="text-align: center;">D/T</th>
            <th style="text-align: right;">PTS</th>
            <th style="text-align: right;">${(data.isTestTourney || data.isTest || (data.tournament && data.tournament.type === "test_match")) ? "QUOT" : "NRR"}</th>
            <th style="text-align: center;">Recent Form</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map((t, idx) => {
            const isQual = Boolean(t.isQualified !== undefined ? t.isQualified : (idx < qualifyCount));
            const isTestTourney = Boolean(data.isTestTourney || data.isTest || (data.tournament && data.tournament.type === "test_match"));
            let rateVal = "0.000";
            let rateColor = "var(--text-muted)";
            if (isTestTourney) {
              const q = typeof t.quotient === "number" ? t.quotient : parseFloat(t.quotient || 1);
              rateVal = q.toFixed(3);
              rateColor = "var(--accent-gold)";
            } else {
              const n = typeof t.nrr === "number" ? t.nrr : parseFloat(t.nrr || 0);
              rateVal = n >= 0 ? `+${n.toFixed(3)}` : n.toFixed(3);
              rateColor = n > 0 ? "var(--accent-green)" : n < 0 ? "var(--accent-crimson)" : "var(--accent-gold)";
            }
            const formList = Array.isArray(t.form)
              ? t.form
              : String(t.form || "").trim().split(/\s+/).filter(Boolean);
            const formBadges = formList.map(f => {
              const letter = f.trim().toUpperCase();
              if (letter === "W") return '<span class="form-badge-pill w">W</span>';
              if (letter === "L") return '<span class="form-badge-pill l">L</span>';
              if (letter === "D") return '<span class="form-badge-pill d">D</span>';
              if (letter === "T") return '<span class="form-badge-pill d">T</span>';
              return "";
            }).join("");

            return `
              <tr class="${isQual ? 'qualified-row' : ''}">
                <td style="font-weight: 700; color: ${isQual ? 'var(--accent-gold)' : 'var(--text-muted)'};">#${idx + 1}</td>
                <td style="font-weight: 600; color: #fff;">
                  <span>${t.name || t.teamName}</span>
                  ${isQual ? '<span class="qualified-badge">🌟 QUALIFIED</span>' : ''}
                </td>
                <td style="text-align: center;">${t.played}</td>
                <td style="text-align: center; color: var(--accent-green); font-weight: 600;">${t.won}</td>
                <td style="text-align: center; color: var(--accent-crimson);">${t.lost}</td>
                <td style="text-align: center; color: var(--text-muted);">${(t.draws || t.draw || 0) + (t.tied || 0)}</td>
                <td style="text-align: right;" class="pts-bold">${t.points}</td>
                <td style="text-align: right; font-family: var(--font-mono); font-weight: 700; color: ${rateColor};">${rateVal}</td>
                <td style="text-align: center;">${formBadges || "-"}</td>
              </tr>
            `;
          }).join("")}
        </tbody>
      </table>
    </div>
  `;
}

function renderTourneySubView() {
  const container = document.getElementById("tourneySubViewContainer");
  const data = state.activeTournamentData;
  if (!data) return;

  const view = state.activeTourneySubView;

  if (view === "standings") {
    // 1. Points Table / Standings View
    let html = "";

    // If tournament has Super Stage, render stage switcher tabs
    if (data.hasSuperStage) {
      const hasSuperMatches = Array.isArray(data.superStageRows) && data.superStageRows.some(r => r.played > 0);
      html += `
        <div class="stage-tabs-group">
          <button class="stage-tab-btn ${state.tourneyActiveStage === 'stage2' ? 'active' : ''}" onclick="setTourneyStage('stage2')">
            <span>⚡ Stage 2: ${data.superStageName || 'Super Stage'}</span>
            ${hasSuperMatches ? '<span style="font-size: 10px; background: rgba(34,197,94,0.2); color: var(--accent-green); padding: 2px 6px; border-radius: var(--radius-full); font-weight: 700; margin-left: 6px;">ACTIVE</span>' : ''}
          </button>
          <button class="stage-tab-btn ${state.tourneyActiveStage === 'stage1' ? 'active' : ''}" onclick="setTourneyStage('stage1')">
            <span>📋 Stage 1: Preliminary Groups / League</span>
          </button>
        </div>
      `;
    }

    if (data.hasSuperStage && state.tourneyActiveStage === "stage2") {
      // Render Super Stage
      if (data.superStageGroups && data.superStageGroups.length > 0) {
        html += `<div style="display: flex; flex-direction: column; gap: 16px;">`;
        for (const gName of data.superStageGroups) {
          const gRows = data.superStageGroupRows ? (data.superStageGroupRows[gName] || []) : [];
          html += renderStandingsTable(gRows, `${data.superStageName || 'Super Stage'} • ${gName}`, data.superStageQualifyCount || 2);
        }
        if (data.superStageRows && data.superStageRows.length > 0) {
          html += renderStandingsTable(data.superStageRows, `${data.superStageName || 'Super Stage'} • Overall Standings`, data.superStageQualifyCount || 4);
        }
        html += `</div>`;
      } else {
        const rows = data.superStageRows && data.superStageRows.length > 0 ? data.superStageRows : data.standings;
        html += renderStandingsTable(rows, `${data.superStageName || 'Super Stage'} Standings`, data.superStageQualifyCount || 4);
      }
    } else {
      // Render Stage 1 (Groups or single table)
      if (data.hasGroups && data.groups && data.groups.length > 0) {
        // Group switcher pills
        html += `
          <div class="group-tabs-group">
            <button class="group-tab-btn ${state.tourneyActiveGroup === 'all' ? 'active' : ''}" onclick="setTourneyGroup('all')">
              All Groups (${data.groups.length})
            </button>
            ${data.groups.map(g => `
              <button class="group-tab-btn ${state.tourneyActiveGroup === g ? 'active' : ''}" onclick="setTourneyGroup('${g}')">
                ${g}
              </button>
            `).join("")}
          </div>
        `;

        if (state.tourneyActiveGroup === "all") {
          for (const g of data.groups) {
            const gRows = data.groupRows ? (data.groupRows[g] || []) : [];
            html += renderStandingsTable(gRows, `${g} Standings`, 2);
          }
        } else {
          const gRows = data.groupRows ? (data.groupRows[state.tourneyActiveGroup] || []) : [];
          html += renderStandingsTable(gRows, `${state.tourneyActiveGroup} Standings`, 2);
        }
      } else {
        html += renderStandingsTable(data.standings, "Official Standings Table", 4);
      }
    }

    container.innerHTML = html;
  } else if (view === "leaders") {
    // 2. Leaders View (Top Batters & Top Bowlers with Matches Played & Averages)
    const batters = data.topBatters || [];
    const bowlers = data.topBowlers || [];

    container.innerHTML = `
      <div class="leaders-two-col">
        <div class="leader-col-card">
          <div class="leader-col-header">
            <span>🏏 Leading Run Scorers</span>
          </div>
          <div style="overflow-x: auto;">
            <table class="card-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Batter</th>
                  <th style="text-align: right;">Mat</th>
                  <th style="text-align: right;">Runs</th>
                  <th style="text-align: right; color: var(--accent-green);">Avg</th>
                  <th style="text-align: right;">100s/50s</th>
                  <th style="text-align: right;">SR</th>
                </tr>
              </thead>
              <tbody>
                ${batters.length > 0 ? batters.map((b, idx) => `
                  <tr onclick="openPlayerModal(${b.id})" style="cursor: pointer;">
                    <td style="font-weight: 700; color: var(--accent-gold);">#${idx + 1}</td>
                    <td style="font-weight: 600; color: #fff;">${b.name}</td>
                    <td style="text-align: right; color: var(--text-muted); font-family: var(--font-mono);">${b.matches || 0}</td>
                    <td style="text-align: right; font-weight: 700; color: var(--accent-gold);">${b.runs}</td>
                    <td style="text-align: right; font-weight: 600; color: var(--accent-green); font-family: var(--font-mono);">${b.average || b.battingAvg || "-"}</td>
                    <td style="text-align: right; color: var(--text-muted);">${b.hundreds} / ${b.fifties}</td>
                    <td style="text-align: right; font-family: var(--font-mono);">${b.strikeRate}</td>
                  </tr>
                `).join("") : '<tr><td colspan="7" style="text-align: center; padding: 20px; color: var(--text-muted);">No batting stats recorded yet.</td></tr>'}
              </tbody>
            </table>
          </div>
        </div>

        <div class="leader-col-card">
          <div class="leader-col-header">
            <span>🎯 Leading Wicket Takers</span>
          </div>
          <div style="overflow-x: auto;">
            <table class="card-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Bowler</th>
                  <th style="text-align: right;">Mat</th>
                  <th style="text-align: right;">Wkts</th>
                  <th style="text-align: right; color: var(--accent-cyan);">Avg</th>
                  <th style="text-align: right;">Overs</th>
                  <th style="text-align: right;">Econ</th>
                </tr>
              </thead>
              <tbody>
                ${bowlers.length > 0 ? bowlers.map((w, idx) => `
                  <tr onclick="openPlayerModal(${w.id})" style="cursor: pointer;">
                    <td style="font-weight: 700; color: var(--accent-gold);">#${idx + 1}</td>
                    <td style="font-weight: 600; color: #fff;">${w.name}</td>
                    <td style="text-align: right; color: var(--text-muted); font-family: var(--font-mono);">${w.matches || 0}</td>
                    <td style="text-align: right; font-weight: 700; color: var(--accent-crimson);">${w.wickets}</td>
                    <td style="text-align: right; font-weight: 600; color: var(--accent-cyan); font-family: var(--font-mono);">${w.average || w.bowlingAvg || "-"}</td>
                    <td style="text-align: right; color: var(--text-muted);">${formatCricketOvers(w.overs)}</td>
                    <td style="text-align: right; font-family: var(--font-mono);">${w.economy}</td>
                  </tr>
                `).join("") : '<tr><td colspan="7" style="text-align: center; padding: 20px; color: var(--text-muted);">No bowling stats recorded yet.</td></tr>'}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    `;
  } else if (view === "teams") {
    // 3. Participating Teams View with comprehensive Win/Loss records across all completed matches
    const teams = (data.participatingTeams && data.participatingTeams.length > 0)
      ? data.participatingTeams
      : (data.standings || []);

    if (teams.length === 0) {
      container.innerHTML = `<div style="text-align: center; padding: 40px; color: var(--text-muted);">No participating teams found.</div>`;
      return;
    }

    container.innerHTML = `
      <div class="teams-showcase-grid">
        ${teams.map(t => {
          const played = t.played || 0;
          const won = t.won || 0;
          const lost = t.lost || 0;
          const draws = t.draws || t.draw || 0;
          const tied = t.tied || 0;
          const noResult = t.noResult || 0;
          const winPct = played > 0 ? Math.round((won / played) * 100) : 0;
          const lossPct = played > 0 ? Math.round((lost / played) * 100) : 0;

          let recordExtra = "";
          if (draws > 0) recordExtra += ` • <span style="color: var(--accent-gold); font-weight: 600;">${draws}D</span>`;
          if (tied > 0) recordExtra += ` • <span style="color: var(--accent-cyan); font-weight: 600;">${tied}T</span>`;
          if (noResult > 0) recordExtra += ` • <span style="color: var(--text-muted);">${noResult}NR</span>`;

          return `
            <div class="team-showcase-card">
              <div class="team-card-shield">${(t.name || t.teamName || "").slice(0, 3).toUpperCase()}</div>
              <div class="team-card-info" style="flex: 1;">
                <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 4px;">
                  <span class="team-card-name">${t.name || t.teamName}</span>
                  <span style="font-family: var(--font-heading); font-size: 13px; font-weight: 800; color: var(--accent-gold);">${t.points || 0} PTS</span>
                </div>
                <div class="team-card-record">
                  <span style="color: var(--accent-green); font-weight: 700;">${won}W</span> - <span style="color: var(--accent-crimson); font-weight: 700;">${lost}L</span>
                  <span style="color: var(--text-muted);"> (${played} Mat)</span>${recordExtra}
                  • <strong style="color: #fff;">${winPct}%</strong> Win Rate
                </div>
                <div style="margin-top: 8px; height: 6px; background: rgba(255,255,255,0.06); border-radius: var(--radius-full); overflow: hidden; display: flex;">
                  <div style="height: 100%; width: ${winPct}%; background: var(--accent-green); transition: width 0.3s ease;" title="${won} Wins"></div>
                  <div style="height: 100%; width: ${lossPct}%; background: var(--accent-crimson); transition: width 0.3s ease;" title="${lost} Losses"></div>
                </div>
              </div>
            </div>
          `;
        }).join("")}
      </div>
    `;
  } else if (view === "matches") {
    // 4. Fixtures / Recent Matches View
    const matches = data.recentMatches || [];
    if (matches.length === 0) {
      container.innerHTML = `<div style="text-align: center; padding: 40px; color: var(--text-muted);">No matches recorded for this tournament.</div>`;
      return;
    }

    container.innerHTML = `
      <div class="matches-grid">
        ${matches.map(m => `
          <div class="recent-match-card" onclick="openScorecardModal(${m.id})">
            <div class="card-header-row">
              <span>Match #${m.id}</span>
              <span class="channel-indicator">Scorecard ➔</span>
            </div>
            <div class="teams-scores-box">
              <div class="team-line"><span class="team-line-name">${m.teamAName}</span><span class="team-line-score">${m.teamAScore}/${m.teamAWickets} (${formatCricketOvers(m.teamAOvers)} ov)</span></div>
              <div class="team-line"><span class="team-line-name">${m.teamBName}</span><span class="team-line-score">${m.teamBScore}/${m.teamBWickets} (${formatCricketOvers(m.teamBOvers)} ov)</span></div>
            </div>
            <div class="match-result-text">🏆 ${m.resultDescription || "Match Completed"}</div>
          </div>
        `).join("")}
      </div>
    `;
  }
}

// -----------------------------------------------------------------------------
// Player Dossier Modal
// -----------------------------------------------------------------------------
async function openPlayerModal(playerId) {
  const modal = document.getElementById("playerModal");
  const modalTitle = document.getElementById("playerModalTitle");
  const modalBody = document.getElementById("playerModalBody");

  modal.classList.remove("hidden");
  modalTitle.textContent = "Player Dossier";
  modalBody.innerHTML = `<div class="loading-state"><div class="spinner"></div><p>Accessing player records...</p></div>`;

  try {
    const res = await apiFetch(`/api/players/${playerId}`, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) throw new Error(`Server returned HTTP ${res.status}`);
    const data = await res.json();
    if (!data.success) throw new Error(data.error);

    const p = data.player;
    const perfs = data.recentPerformances || [];

    modalTitle.textContent = `${p.name} (${p.country})`;

    modalBody.innerHTML = `
      <div class="dossier-hero">
        <div class="overall-rating-badge" style="width: 64px; height: 64px;">
          <span class="rating-num" style="font-size: 26px;">${p.overallRating}</span>
          <span class="rating-lbl">OVR</span>
        </div>
        <div>
          <div class="dossier-name">${p.name}</div>
          <div class="dossier-sub">${p.nationality} • ${(p.archetype || "").replace(/_/g, " ").toUpperCase()} • Age ${p.age}</div>
          <div style="font-size: 13px; color: var(--accent-gold); margin-top: 4px;">
            Batting: ${(p.battingStyle || "").replace(/_/g, " ")} | Bowling: ${(p.bowlingStyle || "").replace(/_/g, " ")}
          </div>
        </div>
      </div>

      <div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px;">
        <div class="rating-metric" style="padding: 10px;"><span class="metric-name">Batting Rating</span><span class="metric-val">${p.battingRating}</span></div>
        <div class="rating-metric" style="padding: 10px;"><span class="metric-name">Bowling Rating</span><span class="metric-val">${p.bowlingRating}</span></div>
        <div class="rating-metric" style="padding: 10px;"><span class="metric-name">Fielding Rating</span><span class="metric-val">${p.fieldingRating}</span></div>
        <div class="rating-metric" style="padding: 10px;"><span class="metric-name">Captaincy Rating</span><span class="metric-val">${p.captaincyRating}</span></div>
      </div>

      <div class="innings-section-title">Career Statistics Across Formats</div>
      <table class="card-table">
        <thead>
          <tr>
            <th>Format</th>
            <th style="text-align: right;">Mat</th>
            <th style="text-align: right;">Runs</th>
            <th style="text-align: right;">HS</th>
            <th style="text-align: right; color: var(--accent-green);">Bat Avg</th>
            <th style="text-align: right;">SR</th>
            <th style="text-align: right;">100s/50s</th>
            <th style="text-align: right;">Wickets</th>
            <th style="text-align: right; color: var(--accent-cyan);">Bowl Avg</th>
            <th style="text-align: right;">Econ</th>
            <th style="text-align: right;">Best Bowling</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td style="font-weight: 700; color: #fff;">Short Formats (T20/10/5)</td>
            <td style="text-align: right;">${p.careerMatches || 0}</td>
            <td style="text-align: right; font-weight: 700; color: var(--accent-gold);">${(p.careerRuns || 0).toLocaleString()}</td>
            <td style="text-align: right;">${p.careerHighestScore || 0}</td>
            <td style="text-align: right; font-weight: 700; color: var(--accent-green); font-family: var(--font-heading); font-size: 14px;">${p.careerBattingAvg || "-"}</td>
            <td style="text-align: right; font-family: var(--font-mono); font-size: 12.5px;">${p.careerStrikeRate || "-"}</td>
            <td style="text-align: right; color: var(--text-muted);">${p.careerHundreds || 0} / ${p.careerFifties || 0}</td>
            <td style="text-align: right; font-weight: 700; color: var(--accent-crimson);">${p.careerWickets || 0}</td>
            <td style="text-align: right; font-weight: 700; color: var(--accent-cyan); font-family: var(--font-heading); font-size: 14px;">${p.careerBowlingAvg || "-"}</td>
            <td style="text-align: right; font-family: var(--font-mono); font-size: 12.5px;">${p.careerEconomy || "-"}</td>
            <td style="text-align: right; font-weight: 600;">${(p.careerBestFiguresWickets > 0 || p.careerBestFiguresRuns > 0) ? `${p.careerBestFiguresWickets || 0}/${p.careerBestFiguresRuns || 0}` : "-"}</td>
          </tr>
          <tr>
            <td style="font-weight: 700; color: #fff;">One Day Internationals (ODI)</td>
            <td style="text-align: right;">${p.odiMatches || 0}</td>
            <td style="text-align: right; font-weight: 700; color: var(--accent-gold);">${(p.odiRuns || 0).toLocaleString()}</td>
            <td style="text-align: right;">${p.odiHighestScore || 0}</td>
            <td style="text-align: right; font-weight: 700; color: var(--accent-green); font-family: var(--font-heading); font-size: 14px;">${p.odiBattingAvg || "-"}</td>
            <td style="text-align: right; font-family: var(--font-mono); font-size: 12.5px;">${p.odiStrikeRate || "-"}</td>
            <td style="text-align: right; color: var(--text-muted);">${p.odiHundreds || 0} / ${p.odiFifties || 0}</td>
            <td style="text-align: right; font-weight: 700; color: var(--accent-crimson);">${p.odiWickets || 0}</td>
            <td style="text-align: right; font-weight: 700; color: var(--accent-cyan); font-family: var(--font-heading); font-size: 14px;">${p.odiBowlingAvg || "-"}</td>
            <td style="text-align: right; font-family: var(--font-mono); font-size: 12.5px;">${p.odiEconomy || "-"}</td>
            <td style="text-align: right; font-weight: 600;">${(p.odiBestFiguresWickets > 0 || p.odiBestFiguresRuns > 0) ? `${p.odiBestFiguresWickets || 0}/${p.odiBestFiguresRuns || 0}` : "-"}</td>
          </tr>
          <tr>
            <td style="font-weight: 700; color: #fff;">Test Matches</td>
            <td style="text-align: right;">${p.testMatches || 0}</td>
            <td style="text-align: right; font-weight: 700; color: var(--accent-gold);">${(p.testRuns || 0).toLocaleString()}</td>
            <td style="text-align: right;">${p.testHighestScore || 0}</td>
            <td style="text-align: right; font-weight: 700; color: var(--accent-green); font-family: var(--font-heading); font-size: 14px;">${p.testBattingAvg || "-"}</td>
            <td style="text-align: right; font-family: var(--font-mono); font-size: 12.5px;">${p.testStrikeRate || "-"}</td>
            <td style="text-align: right; color: var(--text-muted);">${p.testHundreds || 0} / ${p.testFifties || 0}</td>
            <td style="text-align: right; font-weight: 700; color: var(--accent-crimson);">${p.testWickets || 0}</td>
            <td style="text-align: right; font-weight: 700; color: var(--accent-cyan); font-family: var(--font-heading); font-size: 14px;">${p.testBowlingAvg || "-"}</td>
            <td style="text-align: right; font-family: var(--font-mono); font-size: 12.5px;">${p.testEconomy || "-"}</td>
            <td style="text-align: right; font-weight: 600;">${(p.testBestFiguresWickets > 0 || p.testBestFiguresRuns > 0) ? `${p.testBestFiguresWickets || 0}/${p.testBestFiguresRuns || 0}` : "-"}</td>
          </tr>
        </tbody>
      </table>

      ${perfs.length > 0 ? `
        <div class="innings-section-title">Recent Match Contributions</div>
        <div style="display: flex; flex-direction: column; gap: 8px;">
          ${perfs.map(perf => `
            <div style="background: rgba(0,0,0,0.2); padding: 10px 14px; border-radius: var(--radius-sm); display: flex; justify-content: space-between; align-items: center; font-size: 13px;">
              <span><strong>${perf.opponent}</strong> (${perf.format})</span>
              <span>
                ${perf.batting ? `Bat: <strong style="color: var(--accent-gold);">${perf.batting.runs} (${perf.batting.balls}b)</strong>` : ""}
                ${perf.bowling ? `Bowl: <strong style="color: var(--accent-crimson);">${perf.bowling.wickets}/${perf.bowling.runs} (${perf.bowling.overs} ov)</strong>` : ""}
              </span>
            </div>
          `).join("")}
        </div>
      ` : ""}
    `;
  } catch (err) {
    modalBody.innerHTML = `<div class="loading-state"><p>Failed to load profile: ${err.message}</p></div>`;
  }
}

// -----------------------------------------------------------------------------
// Global Overview Footer Counters
// -----------------------------------------------------------------------------
async function loadOverviewStats() {
  try {
    const res = await apiFetch("/api/overview");
    if (!res.ok) return;
    const data = await res.json();
    if (data.success) {
      const matchEl = document.getElementById("footTotalMatches");
      const playerEl = document.getElementById("footTotalPlayers");
      const teamEl = document.getElementById("footTotalTeams");
      if (matchEl && data.totalMatches != null) matchEl.textContent = data.totalMatches.toLocaleString();
      if (playerEl && data.totalPlayers != null) playerEl.textContent = data.totalPlayers.toLocaleString();
      if (teamEl && data.totalTeams != null) teamEl.textContent = data.totalTeams.toLocaleString();
    }
  } catch (err) {
    console.debug("Overview stats fetch:", err);
  }
}

// Modal Closer
function closeModal(id) {
  document.getElementById(id).classList.add("hidden");
}

window.addEventListener("click", (e) => {
  if (e.target.classList.contains("modal-backdrop")) {
    e.target.classList.add("hidden");
  }
});

window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    document.querySelectorAll(".modal-backdrop").forEach(m => m.classList.add("hidden"));
  }
});
