import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const dataDir = path.join(rootDir, "data");
const publicDataDir = path.join(rootDir, "public", "data");

[dataDir, publicDataDir].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

function writeJson(relPath, obj) {
  const content = JSON.stringify(obj);
  [dataDir, publicDataDir].forEach(base => {
    const fullPath = path.join(base, relPath);
    const parent = path.dirname(fullPath);
    if (!fs.existsSync(parent)) fs.mkdirSync(parent, { recursive: true });
    fs.writeFileSync(fullPath, content, "utf8");
  });
}

const BASE_URL = "http://localhost:3000";

async function fetchJson(endpoint) {
  const res = await fetch(`${BASE_URL}${endpoint}`);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${endpoint}`);
  return res.json();
}

// Simple concurrency runner
async function runConcurrent(items, concurrency, fn) {
  let index = 0;
  const results = [];
  const workers = new Array(concurrency).fill(0).map(async () => {
    while (index < items.length) {
      const i = index++;
      try {
        results[i] = await fn(items[i], i);
      } catch (err) {
        results[i] = { error: err.message };
      }
    }
  });
  await Promise.all(workers);
  return results;
}

async function main() {
  console.log("🚀 Starting fast static data export for GitHub Pages...");
  const t0 = Date.now();

  // 1. Overview
  console.log("1. Exporting overview.json...");
  const overview = await fetchJson("/api/overview");
  writeJson("overview.json", overview);

  // 2. Teams
  console.log("2. Exporting teams.json...");
  const teamsData = await fetchJson("/api/teams");
  writeJson("teams.json", teamsData);

  // 3. Tournaments
  console.log("3. Exporting tournaments.json and individual tournament details...");
  const tournamentsData = await fetchJson("/api/tournaments");
  writeJson("tournaments.json", tournamentsData);

  const tournaments = tournamentsData.tournaments || [];
  console.log(`   Found ${tournaments.length} tournaments. Fetching with concurrency 10...`);
  await runConcurrent(tournaments, 10, async (t) => {
    try {
      const detail = await fetchJson(`/api/tournaments/${t.id}`);
      writeJson(`tournaments/${t.id}.json`, detail);
    } catch (e) {
      console.warn(`   ⚠️ Warning: failed to export tournament ${t.id}:`, e.message);
    }
  });
  console.log(`   ✅ Exported ${tournaments.length} tournament detail files.`);

  // 4. Rankings & Leaderboards
  console.log("4. Exporting rankings combinations...");
  const rankingsBundle = {};
  const scopes = [
    { scope: "international", formats: ["odi", "t20", "test"] },
    { scope: "domestic", formats: ["first_class", "list_a", "t20"] },
    { scope: "overall", formats: ["all"] }
  ];

  for (const s of scopes) {
    for (const fmt of s.formats) {
      const key = `${s.scope}_${fmt}`;
      try {
        const data = await fetchJson(`/api/rankings?scope=${s.scope}&format=${fmt}`);
        rankingsBundle[key] = data;
        writeJson(`rankings/${key}.json`, data);
      } catch (e) {
        console.warn(`   ⚠️ Warning: rankings for ${key} failed:`, e.message);
      }
    }
  }
  writeJson("rankings.json", rankingsBundle);
  console.log("   ✅ Rankings bundle generated.");

  // 5. Recent Matches
  console.log("5. Exporting recent matches...");
  try {
    const recent = await fetchJson("/api/matches/recent?limit=50");
    writeJson("matches_recent.json", recent);
  } catch (e) {
    console.warn("   ⚠️ Warning: recent matches failed:", e.message);
  }

  // 6. Players Directory (Full List & Page Bundles)
  console.log("6. Exporting players directory...");
  const { default: pg } = await import("pg");
  const pool = new pg.Pool({
    connectionString: "postgresql://postgres.lkfevcwntvkbkwfdybdi:D8kQDpV2eskCEK2p@13.213.241.248:6543/postgres?sslmode=disable",
    max: 20
  });

  const allPlayersRes = await pool.query(`SELECT * FROM players ORDER BY overall_rating DESC`);
  console.log(`   Fetched ${allPlayersRes.rows.length} total players from DB.`);

  const teamsRes = await pool.query(`SELECT id, name, squad, playing_xi FROM teams`);
  const playerTeamsMap = new Map();
  for (const row of teamsRes.rows) {
    const squad = Array.isArray(row.squad) ? row.squad : [];
    const xi = Array.isArray(row.playing_xi) ? row.playing_xi : [];
    const memberIds = new Set([...squad, ...xi]);
    for (const pid of memberIds) {
      if (!playerTeamsMap.has(pid)) playerTeamsMap.set(pid, []);
      playerTeamsMap.get(pid).push(row.name);
    }
  }

  const formatCountry = (nat) => {
    if (!nat) return "Unknown";
    const parts = nat.split("|").map(s => s.trim());
    return parts[0] || nat;
  };

  const extractTraits = (row) => ({
    safeHands: Boolean(row.safe_hands),
    athleticFielder: Boolean(row.athletic_fielder),
    directHitSpecialist: Boolean(row.direct_hit_specialist),
    bigMatchPlayer: Boolean(row.big_match_player),
    clutchPerformer: Boolean(row.clutch_performer),
    pressureSensitive: Boolean(row.pressure_sensitive),
    pressureHandler: Boolean(row.pressure_handler),
    consistent: Boolean(row.consistent),
    powerplayExpert: Boolean(row.powerplay_expert),
    middleOversSpecialist: Boolean(row.middle_overs_specialist),
    deathOversExpert: Boolean(row.death_overs_expert),
    chaseMaster: Boolean(row.chase_master),
    masterTactician: Boolean(row.master_tactician),
    aggressiveLeader: Boolean(row.aggressive_leader),
    calmLeader: Boolean(row.calm_leader),
    inspirationalCaptain: Boolean(row.inspirational_captain),
    defensiveCaptain: Boolean(row.defensive_captain),
  });

  const getTier = (ovr) => {
    if (ovr >= 90) return "S";
    if (ovr >= 80) return "A";
    if (ovr >= 70) return "B";
    if (ovr >= 60) return "C";
    return "D";
  };

  const allPlayersFormatted = allPlayersRes.rows.map(p => {
    const pTeams = playerTeamsMap.get(p.id) || [];
    const runs = (Number(p.career_runs) || 0) + (Number(p.odi_runs) || 0) + (Number(p.test_runs) || 0);
    const wkts = (Number(p.career_wickets) || 0) + (Number(p.odi_wickets) || 0) + (Number(p.test_wickets) || 0);
    const matches = (Number(p.career_matches) || 0) + (Number(p.odi_matches) || 0) + (Number(p.test_matches) || 0);
    const hs = Math.max(Number(p.career_highest_score) || 0, Number(p.odi_highest_score) || 0, Number(p.test_highest_score) || 0);
    const fifties = (Number(p.career_fifties) || 0) + (Number(p.odi_fifties) || 0) + (Number(p.test_fifties) || 0);
    const hundreds = (Number(p.career_hundreds) || 0) + (Number(p.odi_hundreds) || 0) + (Number(p.test_hundreds) || 0);
    const inn = (Number(p.career_innings) || 0) + (Number(p.odi_innings) || 0) + (Number(p.test_innings) || 0);
    const no = (Number(p.career_not_outs) || 0) + (Number(p.odi_not_outs) || 0) + (Number(p.test_not_outs) || 0);
    const balls = (Number(p.career_balls_faced) || 0) + (Number(p.odi_balls_faced) || 0) + (Number(p.test_balls_faced) || 0);
    const bballs = (Number(p.career_balls_bowled) || 0) + (Number(p.odi_balls_bowled) || 0) + (Number(p.test_balls_bowled) || 0);
    const rc = (Number(p.career_runs_conceded) || 0) + (Number(p.odi_runs_conceded) || 0) + (Number(p.test_runs_conceded) || 0);

    const dismissals = Math.max(0, inn - no);
    const batAvg = dismissals > 0 ? (runs / dismissals).toFixed(2) : runs > 0 ? `${runs}.00*` : "-";
    const strikeRate = balls > 0 ? ((runs / balls) * 100).toFixed(1) : "-";
    const bowlAvg = wkts > 0 ? (rc / wkts).toFixed(2) : "-";
    const econ = bballs > 0 ? ((rc / bballs) * 6).toFixed(2) : "-";

    return {
      id: p.id,
      name: p.name,
      age: p.age,
      nationality: p.nationality,
      country: formatCountry(p.nationality),
      archetype: p.archetype,
      battingStyle: p.batting_style,
      bowlingStyle: p.bowling_style,
      isWicketKeeper: Boolean(p.is_wicket_keeper),
      overallRating: p.overall_rating,
      battingRating: p.batting_rating,
      bowlingRating: p.bowling_rating,
      fieldingRating: p.fielding_rating,
      captaincyRating: p.captaincy_rating,
      tier: getTier(p.overall_rating),
      traits: extractTraits(p),
      teams: pTeams,
      primaryTeam: pTeams[0] || formatCountry(p.nationality),
      stats: {
        matches,
        runs,
        wickets: wkts,
        hundreds,
        fifties,
        highestScore: hs,
        battingAvg: batAvg,
        strikeRate: strikeRate,
        bowlingAvg: bowlAvg,
        economy: econ
      }
    };
  });

  writeJson("players_all.json", {
    success: true,
    total: allPlayersFormatted.length,
    players: allPlayersFormatted
  });
  console.log("   ✅ Saved data/players_all.json");

  // 7. Player Details & Opposition Matchups (Top 350 star players)
  console.log("7. Exporting individual player dossiers with concurrency 20...");
  const playersToExport = allPlayersFormatted.slice(0, 350); // top 350 star players
  let pExported = 0;
  await runConcurrent(playersToExport, 20, async (p) => {
    try {
      const detail = await fetchJson(`/api/players/${p.id}`);
      writeJson(`players/${p.id}.json`, detail);
      pExported++;
    } catch (e) {
      // ignore
    }
  });
  console.log(`   ✅ Exported ${pExported} player dossiers.`);

  // 8. Team Opposition Matchups
  console.log("8. Exporting team opposition matchup records with concurrency 10...");
  const teamList = teamsData.teams || [];
  let tmExported = 0;
  await runConcurrent(teamList, 10, async (t) => {
    try {
      const data = await fetchJson(`/api/matchups/team?name=${encodeURIComponent(t.name)}`);
      if (data && data.success) {
        const slug = t.name.toLowerCase().replace(/[^a-z0-9]+/g, "_");
        writeJson(`matchups/${slug}.json`, data);
        tmExported++;
      }
    } catch (e) {
      // ignore
    }
  });
  console.log(`   ✅ Exported ${tmExported} team opposition matchup files.`);

  await pool.end();
  console.log(`\n🎉 Complete static export completed in ${((Date.now() - t0) / 1000).toFixed(1)} seconds!`);
}

main().catch(err => {
  console.error("❌ Export script failed:", err);
  process.exit(1);
});
