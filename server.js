import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import pg from "pg";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// -----------------------------------------------------------------------------
// Database Connection Pool
// -----------------------------------------------------------------------------
const dbUrl = process.env.DATABASE_URL || process.env.DATABASE_PRIVATE_URL;

if (!dbUrl) {
  console.warn("⚠️  DATABASE_URL environment variable is not defined. Using local fallback or mock.");
}

const pool = new pg.Pool({
  connectionString: dbUrl,
  ssl: process.env.DATABASE_SSL === "false" || (dbUrl && dbUrl.includes("localhost"))
    ? false
    : { rejectUnauthorized: false },
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on("error", (err) => {
  console.error("Unexpected error on idle PostgreSQL client", err);
});

// Helper for database queries
async function query(text, params) {
  const start = Date.now();
  const res = await pool.query(text, params);
  return res;
}

// -----------------------------------------------------------------------------
// Universal Cricket Utilities
// -----------------------------------------------------------------------------
export function formatCricketOvers(oversOrBalls, balls) {
  if (balls !== undefined && balls !== null && !isNaN(Number(balls))) {
    const b = Number(balls);
    return `${Math.floor(b / 6)}.${b % 6}`;
  }
  if (oversOrBalls === undefined || oversOrBalls === null) return "0.0";
  const num = Number(oversOrBalls);
  if (isNaN(num)) return String(oversOrBalls);
  if (Number.isInteger(num)) return `${num}.0`;

  const intPart = Math.floor(num);
  const frac = num - intPart;

  const fracTimes10 = Math.round(frac * 10);
  if (Math.abs(frac - fracTimes10 / 10) < 0.01 && fracTimes10 >= 1 && fracTimes10 <= 5) {
    return `${intPart}.${fracTimes10}`;
  }

  const actualBalls = Math.round(frac * 6);
  if (actualBalls >= 6) {
    return `${intPart + 1}.0`;
  }
  return `${intPart}.${actualBalls}`;
}

function formatCountry(nationality) {
  if (!nationality) return "Unknown";
  return nationality.split("|")[0].trim();
}

// -----------------------------------------------------------------------------
// Tournament Standings Engine (Groups & Super Stages)
// -----------------------------------------------------------------------------
function computeStandingsFromMatches(teams, matches, inningsRows, isTest) {
  const allowedIds = new Set(teams.map((t) => Number(t.id)));
  const allowedNames = new Set(teams.map((t) => t.name.toLowerCase().trim()));
  const isAllowed = (id, name) =>
    allowedIds.has(Number(id)) || allowedNames.has((name || "").toLowerCase().trim());

  const relevantMatches = matches.filter(
    (m) => isAllowed(m.team_a_id, m.team_a_name) || isAllowed(m.team_b_id, m.team_b_name)
  );
  const matchIdSet = new Set(
    relevantMatches
      .filter((m) => !/no result|abandon/i.test(m.result_description || ""))
      .map((m) => m.id)
  );
  const relevantInnings = inningsRows.filter((inn) => matchIdSet.has(inn.match_id));

  const statsMap = new Map();
  const getOrInitTeam = (id, name) => {
    let existing = statsMap.get(id);
    if (!existing) {
      for (const t of statsMap.values()) {
        if (t.name.toLowerCase() === (name || "").toLowerCase().trim()) {
          existing = t;
          break;
        }
      }
    }
    if (!existing) {
      existing = {
        name: (name || "").replace(/\s+/g, " ").trim(),
        id,
        played: 0,
        won: 0,
        lost: 0,
        tied: 0,
        draws: 0,
        noResult: 0,
        points: 0,
        runsScored: 0,
        oversFaced: 0,
        runsConceded: 0,
        oversBowled: 0,
        wicketsLost: 0,
        wicketsTaken: 0,
        nrr: 0.0,
        quotient: 1.0,
        form: [],
      };
      statsMap.set(id, existing);
    }
    return existing;
  };

  for (const t of teams) {
    getOrInitTeam(t.id, t.name);
  }

  for (const m of relevantMatches) {
    const isAllowedA = isAllowed(m.team_a_id, m.team_a_name);
    const isAllowedB = isAllowed(m.team_b_id, m.team_b_name);
    if (!isAllowedA && !isAllowedB) continue;

    const teamA = isAllowedA ? getOrInitTeam(m.team_a_id, m.team_a_name) : null;
    const teamB = isAllowedB ? getOrInitTeam(m.team_b_id, m.team_b_name) : null;

    if (teamA) teamA.played++;
    if (teamB) teamB.played++;

    const isTie = /tie/i.test(m.result_description || "") || /tied/i.test(m.winner_team_name || "");
    const isDraw = /draw/i.test(m.result_description || "") || /draw/i.test(m.winner_team_name || "");
    const isNoResult = /no result|abandon/i.test(m.result_description || "");

    if (isNoResult) {
      if (teamA) { teamA.noResult++; teamA.points += 1; teamA.form.push("NR"); }
      if (teamB) { teamB.noResult++; teamB.points += 1; teamB.form.push("NR"); }
    } else if (isTie) {
      if (teamA) { teamA.tied++; teamA.points += 1; teamA.form.push("T"); }
      if (teamB) { teamB.tied++; teamB.points += 1; teamB.form.push("T"); }
    } else if (isDraw && isTest) {
      if (teamA) { teamA.draws++; teamA.points += 4; teamA.form.push("D"); }
      if (teamB) { teamB.draws++; teamB.points += 4; teamB.form.push("D"); }
    } else {
      const winnerId = m.winner_team_id;
      const winnerName = (m.winner_team_name || "").toLowerCase().trim();

      const aWon = (winnerId && winnerId === m.team_a_id) || (winnerName && winnerName === (m.team_a_name || "").toLowerCase().trim());
      const bWon = (winnerId && winnerId === m.team_b_id) || (winnerName && winnerName === (m.team_b_name || "").toLowerCase().trim());

      const winPts = isTest ? 12 : 2;

      if (aWon) {
        if (teamA) { teamA.won++; teamA.points += winPts; teamA.form.push("W"); }
        if (teamB) { teamB.lost++; teamB.form.push("L"); }
      } else if (bWon) {
        if (teamB) { teamB.won++; teamB.points += winPts; teamB.form.push("W"); }
        if (teamA) { teamA.lost++; teamA.form.push("L"); }
      }
    }
  }

  // Calculate NRR or Quotient
  if (isTest) {
    for (const inn of relevantInnings) {
      const runs = inn.total_runs || 0;
      const wkts = inn.total_wickets || 0;
      let batTeam = statsMap.get(inn.batting_team_id);
      let bowlTeam = statsMap.get(inn.bowling_team_id);

      if (batTeam && isAllowed(batTeam.id, batTeam.name)) {
        batTeam.runsScored += runs;
        batTeam.wicketsLost += wkts;
      }
      if (bowlTeam && isAllowed(bowlTeam.id, bowlTeam.name)) {
        bowlTeam.runsConceded += runs;
        bowlTeam.wicketsTaken += wkts;
      }
    }
    for (const t of statsMap.values()) {
      const batAvg = t.wicketsLost > 0 ? t.runsScored / t.wicketsLost : t.runsScored;
      const bowlAvg = t.wicketsTaken > 0 ? t.runsConceded / t.wicketsTaken : t.runsConceded;
      t.quotient = bowlAvg > 0 ? parseFloat((batAvg / bowlAvg).toFixed(3)) : 1.0;
    }
  } else {
    for (const inn of relevantInnings) {
      const maxOvers = 20;
      const ballsPerOver = 6;
      let batTeam = statsMap.get(inn.batting_team_id);
      let bowlTeam = statsMap.get(inn.bowling_team_id);

      const runs = inn.total_runs || 0;
      const wkts = inn.total_wickets || 0;
      const balls = inn.total_balls || 0;
      const oversActual = balls / ballsPerOver;
      const oversCounted = wkts === 10 ? maxOvers : oversActual;

      if (batTeam && isAllowed(batTeam.id, batTeam.name)) {
        batTeam.runsScored += runs;
        batTeam.oversFaced += oversCounted;
      }
      if (bowlTeam && isAllowed(bowlTeam.id, bowlTeam.name)) {
        bowlTeam.runsConceded += runs;
        bowlTeam.oversBowled += oversCounted;
      }
    }
    for (const t of statsMap.values()) {
      const batRate = t.oversFaced > 0 ? t.runsScored / t.oversFaced : 0;
      const bowlRate = t.oversBowled > 0 ? t.runsConceded / t.oversBowled : 0;
      t.nrr = parseFloat((batRate - bowlRate).toFixed(3));
    }
  }

  return Array.from(statsMap.values())
    .filter((s) => isAllowed(s.id, s.name))
    .sort((a, b) => {
      if (b.points !== a.points) return b.points - a.points;
      if (b.won !== a.won) return b.won - a.won;
      if (isTest) {
        if (Math.abs(b.quotient - a.quotient) > 0.0001) return b.quotient - a.quotient;
      } else {
        if (Math.abs(b.nrr - a.nrr) > 0.0001) return b.nrr - a.nrr;
      }
      if (a.lost !== b.lost) return a.lost - b.lost;
      return a.name.localeCompare(b.name);
    })
    .map((s, idx) => ({
      rank: idx + 1,
      name: s.name,
      teamName: s.name,
      shortName: s.name.slice(0, 4).toUpperCase(),
      played: s.played,
      won: s.won,
      lost: s.lost,
      draws: s.draws,
      tied: s.tied,
      noResult: s.noResult,
      points: s.points,
      nrr: typeof s.nrr === "number" ? (s.nrr > 0 ? `+${s.nrr.toFixed(3)}` : s.nrr.toFixed(3)) : (s.nrr || "0.000"),
      quotient: typeof s.quotient === "number" ? s.quotient.toFixed(3) : (s.quotient || "1.000"),
      form: s.form.join(" ") || "-",
      isQualified: false,
    }));
}

async function computeTournamentStandingsData(tourneyId) {
  const cleanId = tourneyId.trim().toUpperCase();

  const tourneyRes = await query("SELECT * FROM tournaments WHERE UPPER(id) = $1 LIMIT 1", [cleanId]);
  const tourney = tourneyRes.rows[0];
  const isTest = tourney ? tourney.type === "test_match" : false;

  // Standings config from DB
  let config = {
    qualifyCount: 4,
    groupsEnabled: false,
    groupQualifyCounts: {},
    teamGroups: {},
    superStageEnabled: false,
    superStageConfig: { name: "Super 6", teams: [], qualifyCount: 4, groups: {}, groupQualifyCounts: {} },
  };

  try {
    const configRes = await query("SELECT * FROM tournament_standings_configs WHERE UPPER(tournament_id) = $1 LIMIT 1", [cleanId]);
    if (configRes.rows.length > 0) {
      const c = configRes.rows[0];
      config = {
        qualifyCount: c.qualify_count ?? 4,
        groupsEnabled: Boolean(c.groups_enabled),
        groupQualifyCounts: c.group_qualify_counts || {},
        teamGroups: c.team_groups || {},
        superStageEnabled: Boolean(c.super_stage_enabled),
        superStageConfig: c.super_stage_config || { name: "Super 6", teams: [], qualifyCount: 4, groups: {}, groupQualifyCounts: {} },
      };
    }
  } catch (cErr) {
    // Config table might not exist or empty
  }

  // Completed tournament matches
  const matchesRes = await query(`
    SELECT m.id, m.team_a_id, m.team_b_id, m.team_a_name, m.team_b_name,
           m.winner_team_id, m.winner_team_name, m.result_description, m.format, m.status,
           m.completed_at, m.created_at
    FROM tournament_matches tm
    INNER JOIN matches m ON m.id = tm.match_id
    WHERE UPPER(tm.tournament_id) = $1 AND m.status = 'completed'
    ORDER BY COALESCE(m.completed_at, m.created_at) ASC, m.id ASC
  `, [cleanId]);

  const completedMatches = matchesRes.rows;

  if (completedMatches.length === 0) {
    // Fallback to teams table
    const dbTeams = await query("SELECT * FROM teams WHERE UPPER(tournament_id) LIKE $1", [`%${cleanId}%`]);
    const fallbackStandings = dbTeams.rows.map((t, idx) => ({
      rank: idx + 1,
      name: t.name,
      teamName: t.name,
      shortName: t.short_name || t.name.slice(0, 4).toUpperCase(),
      played: t.matches_played || 0,
      won: t.matches_won || 0,
      lost: t.matches_lost || 0,
      draws: t.matches_draw || 0,
      tied: 0,
      noResult: 0,
      points: (t.matches_won || 0) * 2 + (t.matches_draw || 0),
      nrr: "0.000",
      quotient: "1.000",
      form: "-",
      isQualified: idx < (config.qualifyCount || 4),
    }));

    return {
      standings: fallbackStandings,
      hasGroups: false,
      groups: [],
      groupRows: {},
      hasSuperStage: false,
      superStageName: "Super Stage",
      superStageRows: [],
      superStageGroups: [],
      superStageGroupRows: {},
    };
  }

  const matchIds = completedMatches.map((m) => m.id);
  const inningsRes = await query(`
    SELECT match_id, batting_team_id, bowling_team_id, total_runs, total_wickets, total_balls
    FROM match_innings
    WHERE match_id = ANY($1::int[])
  `, [matchIds]);

  const teamTotalMatches = new Map();
  for (const m of completedMatches) {
    if (!teamTotalMatches.has(m.team_a_id)) {
      teamTotalMatches.set(m.team_a_id, { id: m.team_a_id, name: m.team_a_name.replace(/\s+/g, " ").trim(), count: 0 });
    }
    if (!teamTotalMatches.has(m.team_b_id)) {
      teamTotalMatches.set(m.team_b_id, { id: m.team_b_id, name: m.team_b_name.replace(/\s+/g, " ").trim(), count: 0 });
    }
    teamTotalMatches.get(m.team_a_id).count++;
    teamTotalMatches.get(m.team_b_id).count++;
  }

  const allTeams = Array.from(teamTotalMatches.values());

  // Distinct groups
  const groupSet = new Set();
  if (config.teamGroups) {
    for (const val of Object.values(config.teamGroups)) {
      if (val) groupSet.add(String(val).trim());
    }
  }
  const uniqueGroups = Array.from(groupSet).sort();

  const getTeamGroup = (tId, tName) => {
    if (!config.teamGroups) return null;
    if (config.teamGroups[String(tId)]) return config.teamGroups[String(tId)];
    if (config.teamGroups[tName]) return config.teamGroups[tName];
    return null;
  };

  // League match cut-off calculation
  const sortedCounts = allTeams.map((t) => t.count).sort((a, b) => a - b);
  const numTeams = allTeams.length;
  let leagueK = sortedCounts[0] || 0;
  if (numTeams >= 6) {
    const regularTeams = sortedCounts.slice(0, Math.max(1, numTeams - 4));
    leagueK = Math.max(...regularTeams);
  }

  const roundRobinMatches = [];
  const currentCounts = new Map();
  for (const m of completedMatches) {
    const aCount = currentCounts.get(m.team_a_id) || 0;
    const bCount = currentCounts.get(m.team_b_id) || 0;
    if (aCount < leagueK && bCount < leagueK) {
      currentCounts.set(m.team_a_id, aCount + 1);
      currentCounts.set(m.team_b_id, bCount + 1);
      roundRobinMatches.push(m);
    }
  }

  const overallRows = computeStandingsFromMatches(allTeams, roundRobinMatches, inningsRes.rows, isTest);
  const defaultQualify = config.qualifyCount ?? 4;
  overallRows.forEach((r, idx) => {
    r.isQualified = idx < defaultQualify;
  });

  const groupRows = {};
  if (config.groupsEnabled && uniqueGroups.length > 0) {
    for (const grp of uniqueGroups) {
      const teamsInGroup = allTeams.filter((t) => {
        const assigned = getTeamGroup(t.id, t.name);
        return assigned && assigned.toLowerCase() === grp.toLowerCase();
      });
      const gRows = computeStandingsFromMatches(teamsInGroup, roundRobinMatches, inningsRes.rows, isTest);
      const gQualify = config.groupQualifyCounts?.[grp] ?? 2;
      gRows.forEach((r, idx) => {
        r.isQualified = idx < gQualify;
      });
      groupRows[grp] = gRows;
    }
  }
  groupRows["Overall"] = overallRows;

  // Super Stage Check
  const hasSuper = Boolean(config.superStageEnabled);
  const superName = config.superStageConfig?.name || "Super Stage";
  let superStageRows = [];
  const superStageGroups = [];
  const superStageGroupRows = {};

  if (hasSuper) {
    let superTeams = [];
    if (Array.isArray(config.superStageConfig?.teams) && config.superStageConfig.teams.length > 0) {
      const sNames = new Set(config.superStageConfig.teams.map((x) => String(x).toLowerCase().trim()));
      superTeams = allTeams.filter((t) => sNames.has(t.name.toLowerCase().trim()) || sNames.has(String(t.id)));
    } else {
      // Auto-detect qualifiers
      if (config.groupsEnabled && uniqueGroups.length > 0) {
        for (const grp of uniqueGroups) {
          const gR = groupRows[grp] || [];
          const qCount = config.groupQualifyCounts?.[grp] ?? 2;
          for (let i = 0; i < Math.min(qCount, gR.length); i++) {
            const found = allTeams.find((t) => t.name.toLowerCase().trim() === gR[i].name.toLowerCase().trim());
            if (found && !superTeams.some((st) => st.id === found.id)) superTeams.push(found);
          }
        }
      } else {
        superTeams = allTeams.slice(0, 6);
      }
    }

    if (superTeams.length > 0) {
      superStageRows = computeStandingsFromMatches(superTeams, completedMatches, inningsRes.rows, isTest);
      const sQualify = config.superStageConfig?.qualifyCount ?? 4;
      superStageRows.forEach((r, idx) => {
        r.isQualified = idx < sQualify;
      });
    }
  }

  const primaryStandings = (config.groupsEnabled && uniqueGroups.length > 0 && groupRows[uniqueGroups[0]])
    ? groupRows[uniqueGroups[0]]
    : overallRows;

  return {
    standings: primaryStandings,
    hasGroups: Boolean(config.groupsEnabled && uniqueGroups.length > 0),
    groups: uniqueGroups,
    groupRows,
    hasSuperStage: hasSuper,
    superStageName: superName,
    superStageRows,
    superStageGroups,
    superStageGroupRows,
  };
}

// -----------------------------------------------------------------------------
// 1. Live Streaming Matches (/api/live)
// -----------------------------------------------------------------------------
app.get("/api/live", async (req, res) => {
  try {
    const liveMatches = [];

    // Query active_match_states from DB (shared with bot host)
    try {
      const dbActiveStates = await query("SELECT * FROM active_match_states");
      for (const row of dbActiveStates.rows) {
        const ms = row.state;
        if (!ms || !ms.matchId || ms.isComplete) continue;

        const inn = ms.currentInningsState || (ms.innings && ms.innings[ms.currentInnings || 0]);
        const battingTeamName = inn?.teamName || ms.teamAName || ms.teamA?.team?.name || "Batting Team";
        const bowlingTeamName = (battingTeamName === (ms.teamAName || ms.teamA?.team?.name) ? (ms.teamBName || ms.teamB?.team?.name) : (ms.teamAName || ms.teamA?.team?.name)) || "Bowling Team";

        const striker = inn?.batters?.[inn.strikerIndex];
        const nonStriker = inn?.batters?.[inn.nonStrikerIndex];
        const bowler = inn?.currentBowler;
        const totalRuns = inn?.totalRuns ?? 0;
        const totalBalls = inn?.totalBalls ?? 0;
        const totalWickets = inn?.totalWickets ?? 0;
        const totalOversMax = ms.totalOvers || 20;

        const crr = totalBalls > 0 ? ((totalRuns / totalBalls) * 6).toFixed(2) : "0.00";
        let rrr = null;
        if (ms.target && ms.currentInnings >= 1) {
          const runsNeeded = Math.max(0, ms.target - totalRuns);
          const ballsRemaining = Math.max(0, totalOversMax * 6 - totalBalls);
          rrr = ballsRemaining > 0 ? ((runsNeeded / ballsRemaining) * 6).toFixed(2) : "0.00";
        }

        liveMatches.push({
          matchId: ms.matchId,
          format: (ms.format || "cricket").toUpperCase().replace(/_/g, " "),
          pitchType: (ms.pitchType || "balanced").replace(/_/g, " "),
          stadiumName: ms.stadiumName || "Virtual Cricket Arena",
          weather: ms.weather || "clear",
          teamA: {
            name: ms.teamAName || ms.teamA?.team?.name || "Team A",
            shortName: ms.teamA?.team?.shortName || "TMA",
            logoUrl: ms.teamA?.team?.logoUrl || null,
          },
          teamB: {
            name: ms.teamBName || ms.teamB?.team?.name || "Team B",
            shortName: ms.teamB?.team?.shortName || "TMB",
            logoUrl: ms.teamB?.team?.logoUrl || null,
          },
          battingTeamName,
          bowlingTeamName,
          currentInnings: (ms.currentInnings || 0) + 1,
          totalInnings: ms.format === "test" ? 4 : 2,
          score: `${totalRuns}/${totalWickets}`,
          overs: formatCricketOvers(null, totalBalls),
          totalOversMax,
          crr,
          rrr,
          target: ms.target || null,
          striker: striker ? {
            name: striker.name,
            runs: striker.runs,
            balls: striker.balls,
            fours: striker.fours,
            sixes: striker.sixes,
            strikeRate: striker.balls > 0 ? ((striker.runs / striker.balls) * 100).toFixed(1) : "0.0",
          } : null,
          nonStriker: nonStriker ? {
            name: nonStriker.name,
            runs: nonStriker.runs,
            balls: nonStriker.balls,
            fours: nonStriker.fours,
            sixes: nonStriker.sixes,
            strikeRate: nonStriker.balls > 0 ? ((nonStriker.runs / nonStriker.balls) * 100).toFixed(1) : "0.0",
          } : null,
          currentBowler: bowler ? {
            name: bowler.name,
            overs: formatCricketOvers(null, bowler.oversBowled),
            maidens: bowler.maidens || 0,
            runs: bowler.runsConceded || 0,
            wickets: bowler.wickets || 0,
            economy: bowler.oversBowled > 0 ? ((bowler.runsConceded / bowler.oversBowled) * 6).toFixed(2) : "0.00",
          } : null,
          currentOverBalls: inn?.currentOverBalls || [],
          recentHighlights: (inn?.highlights || []).slice(-6).reverse().map((h) => ({
            over: h.over,
            commentary: h.description,
            type: h.type,
          })),
          discord: {
            channelId: ms.channelId,
            channelName: "Virtual Cricket Arena",
            channelUrl: `https://discord.com/channels/@me/${ms.channelId}`,
            guildName: "Virtual Universe",
          },
          isLive: true,
        });
      }
    } catch (err) {
      console.warn("Could not read active_match_states:", err.message);
    }

    res.json({
      success: true,
      count: liveMatches.length,
      matches: liveMatches,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error("Error in /api/live:", err);
    res.status(500).json({ success: false, error: err.message || "Failed to load live matches" });
  }
});

// -----------------------------------------------------------------------------
// 2. Recent Completed Matches (/api/matches/recent)
// -----------------------------------------------------------------------------
app.get("/api/matches/recent", async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 20, 50);
    const format = req.query.format ? String(req.query.format) : null;

    let sqlQuery = "SELECT * FROM matches WHERE status = 'completed'";
    const params = [];
    if (format) {
      params.push(format);
      sqlQuery += " AND format = $1";
    }
    sqlQuery += ` ORDER BY id DESC LIMIT ${limit}`;

    const { rows } = await query(sqlQuery, params);
    const formatted = rows.map((m) => ({
      id: m.id,
      teamAName: m.team_a_name,
      teamBName: m.team_b_name,
      teamAScore: m.team_a_score,
      teamAWickets: m.team_a_wickets,
      teamAOvers: formatCricketOvers(m.team_a_overs),
      teamBScore: m.team_b_score,
      teamBWickets: m.team_b_wickets,
      teamBOvers: formatCricketOvers(m.team_b_overs),
      format: (m.format || "").toUpperCase().replace(/_/g, " "),
      pitchType: (m.pitch_type || "").replace(/_/g, " "),
      stadiumName: m.stadium_name || "Virtual Cricket Arena",
      winnerTeamName: m.winner_team_name,
      resultDescription: m.result_description,
      playerOfMatchName: m.player_of_match_name,
      channel: {
        id: m.channel_id,
        name: "Virtual Arena",
        url: `https://discord.com/channels/@me/${m.channel_id}`,
      },
      completedAt: m.completed_at,
    }));

    res.json({ success: true, count: formatted.length, matches: formatted });
  } catch (err) {
    console.error("Error in /api/matches/recent:", err);
    res.status(500).json({ success: false, error: err.message || "Failed to load matches" });
  }
});

// -----------------------------------------------------------------------------
// 3. Match Details & Scorecard (/api/matches/:id)
// -----------------------------------------------------------------------------
app.get("/api/matches/:id", async (req, res) => {
  try {
    const matchId = Number(req.params.id);
    if (!matchId) return res.status(400).json({ success: false, error: "Invalid match ID" });

    const matchRes = await query("SELECT * FROM matches WHERE id = $1 LIMIT 1", [matchId]);
    if (matchRes.rows.length === 0) return res.status(404).json({ success: false, error: "Match not found" });

    const match = matchRes.rows[0];
    const innRes = await query("SELECT * FROM match_innings WHERE match_id = $1 ORDER BY innings_number ASC", [matchId]);

    const formattedInnings = innRes.rows.map((inn) => {
      const bowlingCard = (inn.bowling_card || []).map((w) => ({
        ...w,
        overs: formatCricketOvers(w.overs, w.balls),
      }));
      return {
        ...inn,
        overs: formatCricketOvers(null, inn.total_balls),
        bowlingCard,
      };
    });

    const deliveriesRes = await query("SELECT * FROM match_deliveries WHERE match_id = $1 ORDER BY id DESC LIMIT 30", [matchId]);

    res.json({
      success: true,
      match: {
        ...match,
        teamAOvers: formatCricketOvers(match.team_a_overs),
        teamBOvers: formatCricketOvers(match.team_b_overs),
        channelName: "Virtual Arena",
        channelUrl: `https://discord.com/channels/@me/${match.channel_id}`,
      },
      innings: formattedInnings,
      recentDeliveries: deliveriesRes.rows,
    });
  } catch (err) {
    console.error("Error in /api/matches/:id:", err);
    res.status(500).json({ success: false, error: err.message || "Failed to load match details" });
  }
});

// -----------------------------------------------------------------------------
// 4. Players Directory & Enhanced Search (/api/players)
// -----------------------------------------------------------------------------
app.get("/api/players", async (req, res) => {
  try {
    const search = req.query.search ? String(req.query.search).trim() : "";
    const country = req.query.country ? String(req.query.country).trim() : "";
    const archetype = req.query.archetype ? String(req.query.archetype).trim() : "";
    const role = req.query.role ? String(req.query.role).trim() : "";
    const trait = req.query.trait ? String(req.query.trait).trim() : "";
    const bowlingStyle = req.query.bowlingStyle ? String(req.query.bowlingStyle).trim() : "";
    const battingStyle = req.query.battingStyle ? String(req.query.battingStyle).trim() : "";
    const ratingTier = req.query.tier ? String(req.query.tier).trim() : "";
    const sortBy = req.query.sort ? String(req.query.sort) : "overall";
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(Math.max(1, Number(req.query.limit) || 36), 100);
    const offset = (page - 1) * limit;

    const conditions = [];
    const params = [];

    if (search) {
      params.push(`%${search}%`);
      if (/^\d+$/.test(search)) {
        params.push(Number(search));
        conditions.push(`(name ILIKE $${params.length - 1} OR id = $${params.length})`);
      } else {
        conditions.push(`name ILIKE $${params.length}`);
      }
    }
    if (country && country !== "All") {
      params.push(`%${country}%`);
      conditions.push(`nationality ILIKE $${params.length}`);
    }
    if (archetype && archetype !== "All") {
      params.push(archetype);
      conditions.push(`archetype = $${params.length}`);
    }
    if (battingStyle && battingStyle !== "All") {
      params.push(battingStyle);
      conditions.push(`batting_style = $${params.length}`);
    }
    if (bowlingStyle && bowlingStyle !== "All") {
      params.push(`%${bowlingStyle}%`);
      conditions.push(`bowling_style ILIKE $${params.length}`);
    }
    if (trait && trait !== "All") {
      if (trait === "pressureHandler") conditions.push("pressure_handler = true");
      else if (trait === "clutchPerformer") conditions.push("clutch_performer = true");
      else if (trait === "bigMatchPlayer") conditions.push("big_match_player = true");
      else if (trait === "chaseMaster") conditions.push("chase_master = true");
      else if (trait === "deathOversExpert") conditions.push("death_overs_expert = true");
      else if (trait === "consistent") conditions.push("consistent = true");
    }
    if (ratingTier && ratingTier !== "All") {
      if (ratingTier === "elite") conditions.push("overall_rating >= 80");
      else if (ratingTier === "gold") conditions.push("overall_rating >= 75 AND overall_rating < 80");
      else if (ratingTier === "silver") conditions.push("overall_rating >= 70 AND overall_rating < 75");
      else if (ratingTier === "bronze") conditions.push("overall_rating < 70");
    }
    if (role && role !== "All") {
      if (role === "wicket_keeper") {
        conditions.push("is_wicket_keeper = true");
      } else if (role === "batter") {
        conditions.push("archetype IN ('aggressive', 'anchor', 'finisher')");
      } else if (role === "bowler") {
        conditions.push("archetype IN ('pace_spearhead', 'swing_bowler', 'death_specialist', 'spinner', 'mystery_spinner')");
      } else if (role === "all_rounder") {
        conditions.push("archetype IN ('batting_all_rounder', 'balanced_all_rounder', 'bowling_all_rounder')");
      }
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    let orderClause = "ORDER BY overall_rating DESC";
    if (sortBy === "runs") {
      orderClause = "ORDER BY (COALESCE(career_runs,0) + COALESCE(odi_runs,0)) DESC";
    } else if (sortBy === "wickets") {
      orderClause = "ORDER BY (COALESCE(career_wickets,0) + COALESCE(odi_wickets,0)) DESC";
    } else if (sortBy === "batting") {
      orderClause = "ORDER BY batting_rating DESC";
    } else if (sortBy === "bowling") {
      orderClause = "ORDER BY bowling_rating DESC";
    } else if (sortBy === "centuries") {
      orderClause = "ORDER BY (COALESCE(career_hundreds,0) + COALESCE(odi_hundreds,0)) DESC";
    } else if (sortBy === "fifties") {
      orderClause = "ORDER BY (COALESCE(career_fifties,0) + COALESCE(odi_fifties,0)) DESC";
    }

    const countRes = await query(`SELECT COUNT(*) as count FROM players ${whereClause}`, params);
    const total = Number(countRes.rows[0]?.count || 0);

    const playersRes = await query(
      `SELECT * FROM players ${whereClause} ${orderClause}, overall_rating DESC LIMIT ${limit} OFFSET ${offset}`,
      params
    );

    const formatted = playersRes.rows.map((p) => ({
      id: p.id,
      name: p.name,
      age: p.age,
      nationality: p.nationality,
      country: formatCountry(p.nationality),
      archetype: p.archetype,
      battingStyle: p.batting_style,
      bowlingStyle: p.bowling_style,
      isWicketKeeper: p.is_wicket_keeper,
      overallRating: p.overall_rating,
      battingRating: p.batting_rating,
      bowlingRating: p.bowling_rating,
      fieldingRating: p.fielding_rating,
      captaincyRating: p.captaincy_rating,
      traits: {
        pressureHandler: p.pressure_handler,
        clutchPerformer: p.clutch_performer,
        bigMatchPlayer: p.big_match_player,
        chaseMaster: p.chase_master,
        deathOversExpert: p.death_overs_expert,
        consistent: p.consistent,
      },
      stats: {
        matches: (p.career_matches || 0) + (p.odi_matches || 0),
        runs: (p.career_runs || 0) + (p.odi_runs || 0),
        wickets: (p.career_wickets || 0) + (p.odi_wickets || 0),
        hundreds: (p.career_hundreds || 0) + (p.odi_hundreds || 0),
        fifties: (p.career_fifties || 0) + (p.odi_fifties || 0),
        highestScore: Math.max(p.career_highest_score || 0, p.odi_highest_score || 0),
      },
    }));

    res.json({
      success: true,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
      players: formatted,
    });
  } catch (err) {
    console.error("Error in /api/players:", err);
    res.status(500).json({ success: false, error: err.message || "Failed to load players" });
  }
});

// -----------------------------------------------------------------------------
// 5. Player Comparison (Head to Head) (/api/players/compare)
// -----------------------------------------------------------------------------
app.get("/api/players/compare", async (req, res) => {
  try {
    const p1Query = String(req.query.p1 || "").trim();
    const p2Query = String(req.query.p2 || "").trim();
    const format = String(req.query.format || "all").toLowerCase();

    if (!p1Query || !p2Query) {
      return res.status(400).json({ success: false, error: "Please provide both p1 and p2 parameters" });
    }

    const resolvePlayer = async (input) => {
      if (/^\d+$/.test(input)) {
        const { rows } = await query("SELECT * FROM players WHERE id = $1 LIMIT 1", [Number(input)]);
        return rows[0] || null;
      }
      const { rows } = await query("SELECT * FROM players WHERE name ILIKE $1 LIMIT 1", [`%${input}%`]);
      return rows[0] || null;
    };

    const [player1, player2] = await Promise.all([resolvePlayer(p1Query), resolvePlayer(p2Query)]);

    if (!player1 || !player2) {
      return res.status(404).json({
        success: false,
        error: `Could not find ${!player1 ? `Player 1 (${p1Query})` : `Player 2 (${p2Query})`}`,
      });
    }

    const getStats = (p) => {
      if (format === "odi") {
        return {
          matches: p.odi_matches || 0,
          innings: p.odi_innings || 0,
          runs: p.odi_runs || 0,
          ballsFaced: p.odi_balls_faced || 0,
          hundreds: p.odi_hundreds || 0,
          fifties: p.odi_fifties || 0,
          highestScore: p.odi_highest_score || 0,
          wickets: p.odi_wickets || 0,
          oversBowled: formatCricketOvers(null, p.odi_balls_bowled || 0),
          bestBowling: `${p.odi_best_figures_wickets || 0}/${p.odi_best_figures_runs || 0}`,
          battingAvg: (p.odi_innings || 0) > 0 ? ((p.odi_runs || 0) / Math.max(1, (p.odi_innings || 0) - (p.odi_not_outs || 0))).toFixed(2) : "0.00",
          strikeRate: (p.odi_balls_faced || 0) > 0 ? (((p.odi_runs || 0) / (p.odi_balls_faced || 0)) * 100).toFixed(1) : "0.0",
          economy: (p.odi_balls_bowled || 0) > 0 ? (((p.odi_runs_conceded || 0) / (p.odi_balls_bowled || 0)) * 6).toFixed(2) : "0.00",
        };
      } else if (format === "test") {
        return {
          matches: p.test_matches || 0,
          innings: p.test_innings || 0,
          runs: p.test_runs || 0,
          ballsFaced: p.test_balls_faced || 0,
          hundreds: p.test_hundreds || 0,
          fifties: p.test_fifties || 0,
          highestScore: p.test_highest_score || 0,
          wickets: p.test_wickets || 0,
          oversBowled: formatCricketOvers(null, p.test_balls_bowled || 0),
          bestBowling: `${p.test_best_figures_wickets || 0}/${p.test_best_figures_runs || 0}`,
          battingAvg: (p.test_innings || 0) > 0 ? ((p.test_runs || 0) / Math.max(1, (p.test_innings || 0) - (p.test_not_outs || 0))).toFixed(2) : "0.00",
          strikeRate: (p.test_balls_faced || 0) > 0 ? (((p.test_runs || 0) / (p.test_balls_faced || 0)) * 100).toFixed(1) : "0.0",
          economy: (p.test_balls_bowled || 0) > 0 ? (((p.test_runs_conceded || 0) / (p.test_balls_bowled || 0)) * 6).toFixed(2) : "0.00",
        };
      } else if (format === "short") {
        return {
          matches: p.career_matches || 0,
          innings: p.career_innings || 0,
          runs: p.career_runs || 0,
          ballsFaced: p.career_balls_faced || 0,
          hundreds: p.career_hundreds || 0,
          fifties: p.career_fifties || 0,
          highestScore: p.career_highest_score || 0,
          wickets: p.career_wickets || 0,
          oversBowled: formatCricketOvers(null, p.career_balls_bowled || 0),
          bestBowling: `${p.career_best_figures_wickets || 0}/${p.career_best_figures_runs || 0}`,
          battingAvg: (p.career_innings || 0) > 0 ? ((p.career_runs || 0) / Math.max(1, (p.career_innings || 0) - (p.career_not_outs || 0))).toFixed(2) : "0.00",
          strikeRate: (p.career_balls_faced || 0) > 0 ? (((p.career_runs || 0) / (p.career_balls_faced || 0)) * 100).toFixed(1) : "0.0",
          economy: (p.career_balls_bowled || 0) > 0 ? (((p.career_runs_conceded || 0) / (p.career_balls_bowled || 0)) * 6).toFixed(2) : "0.00",
        };
      }

      // Default: "all"
      const totalRuns = (p.career_runs || 0) + (p.odi_runs || 0) + (p.test_runs || 0);
      const totalBalls = (p.career_balls_faced || 0) + (p.odi_balls_faced || 0) + (p.test_balls_faced || 0);
      const totalWickets = (p.career_wickets || 0) + (p.odi_wickets || 0) + (p.test_wickets || 0);
      const totalBallsBowled = (p.career_balls_bowled || 0) + (p.odi_balls_bowled || 0) + (p.test_balls_bowled || 0);
      const totalRunsConceded = (p.career_runs_conceded || 0) + (p.odi_runs_conceded || 0) + (p.test_runs_conceded || 0);
      const totalDismissals = ((p.career_innings || 0) - (p.career_not_outs || 0)) + ((p.odi_innings || 0) - (p.odi_not_outs || 0)) + ((p.test_innings || 0) - (p.test_not_outs || 0));

      return {
        matches: (p.career_matches || 0) + (p.odi_matches || 0) + (p.test_matches || 0),
        runs: totalRuns,
        hundreds: (p.career_hundreds || 0) + (p.odi_hundreds || 0) + (p.test_hundreds || 0),
        fifties: (p.career_fifties || 0) + (p.odi_fifties || 0) + (p.test_fifties || 0),
        highestScore: Math.max(p.career_highest_score || 0, p.odi_highest_score || 0, p.test_highest_score || 0),
        wickets: totalWickets,
        oversBowled: formatCricketOvers(null, totalBallsBowled),
        bestBowling: `${p.career_best_figures_wickets || p.odi_best_figures_wickets || p.test_best_figures_wickets || 0}/${p.career_best_figures_runs || p.odi_best_figures_runs || p.test_best_figures_runs || 0}`,
        battingAvg: totalRuns > 0 ? (totalRuns / Math.max(1, totalDismissals)).toFixed(2) : "0.00",
        strikeRate: totalBalls > 0 ? ((totalRuns / totalBalls) * 100).toFixed(1) : "0.0",
        economy: totalBallsBowled > 0 ? ((totalRunsConceded / totalBallsBowled) * 6).toFixed(2) : "0.00",
      };
    };

    const s1 = getStats(player1);
    const s2 = getStats(player2);

    let verdict = `${player1.name} and ${player2.name} are evenly matched.`;
    if (player1.overall_rating > player2.overall_rating + 1) {
      verdict = `${player1.name} leads overall with higher ratings (${player1.overall_rating} OVR vs ${player2.overall_rating} OVR).`;
    } else if (player2.overall_rating > player1.overall_rating + 1) {
      verdict = `${player2.name} leads overall with higher ratings (${player2.overall_rating} OVR vs ${player1.overall_rating} OVR).`;
    }

    const formatLabel = format === "short" ? "Short Formats (T20/T10)" : format === "odi" ? "ODI (50-Over)" : format === "test" ? "Test Matches" : "All Formats Combined";

    res.json({
      success: true,
      format,
      formatLabel,
      comparison: { verdict },
      player1: {
        id: player1.id,
        name: player1.name,
        country: formatCountry(player1.nationality),
        archetype: player1.archetype,
        overallRating: player1.overall_rating,
        battingRating: player1.batting_rating,
        bowlingRating: player1.bowling_rating,
        fieldingRating: player1.fielding_rating,
        captaincyRating: player1.captaincy_rating,
        battingStyle: player1.batting_style,
        bowlingStyle: player1.bowling_style,
        traits: {
          pressureHandler: player1.pressure_handler,
          clutchPerformer: player1.clutch_performer,
          bigMatchPlayer: player1.big_match_player,
          chaseMaster: player1.chase_master,
          deathOversExpert: player1.death_overs_expert,
          consistent: player1.consistent,
        },
        stats: s1,
      },
      player2: {
        id: player2.id,
        name: player2.name,
        country: formatCountry(player2.nationality),
        archetype: player2.archetype,
        overallRating: player2.overall_rating,
        battingRating: player2.batting_rating,
        bowlingRating: player2.bowling_rating,
        fieldingRating: player2.fielding_rating,
        captaincyRating: player2.captaincy_rating,
        battingStyle: player2.batting_style,
        bowlingStyle: player2.bowling_style,
        traits: {
          pressureHandler: player2.pressure_handler,
          clutchPerformer: player2.clutch_performer,
          bigMatchPlayer: player2.big_match_player,
          chaseMaster: player2.chase_master,
          deathOversExpert: player2.death_overs_expert,
          consistent: player2.consistent,
        },
        stats: s2,
      },
      advantage: {
        overall: player1.overall_rating > player2.overall_rating ? 1 : player2.overall_rating > player1.overall_rating ? 2 : 0,
        batting: player1.batting_rating > player2.batting_rating ? 1 : player2.batting_rating > player1.batting_rating ? 2 : 0,
        bowling: player1.bowling_rating > player2.bowling_rating ? 1 : player2.bowling_rating > player1.bowling_rating ? 2 : 0,
        runs: s1.runs > s2.runs ? 1 : s2.runs > s1.runs ? 2 : 0,
        wickets: s1.wickets > s2.wickets ? 1 : s2.wickets > s1.wickets ? 2 : 0,
      },
    });
  } catch (err) {
    console.error("Error in /api/players/compare:", err);
    res.status(500).json({ success: false, error: err.message || "Failed to compare players" });
  }
});

// -----------------------------------------------------------------------------
// 6. Single Player Dossier (/api/players/:id) - Fast Subquery (<10ms)
// -----------------------------------------------------------------------------
app.get("/api/players/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ success: false, error: "Invalid player ID" });

    const pRes = await query("SELECT * FROM players WHERE id = $1 LIMIT 1", [id]);
    if (pRes.rows.length === 0) return res.status(404).json({ success: false, error: "Player not found" });

    const player = pRes.rows[0];

    // Subquery scans only recent 200 innings for lightning-fast response
    const recentInnings = await query(`
      SELECT mi.id, mi.match_id, mi.batting_card, mi.bowling_card, m.team_a_name, m.team_b_name, m.format, m.completed_at
      FROM (
        SELECT id, match_id, batting_card, bowling_card
        FROM match_innings
        ORDER BY id DESC
        LIMIT 200
      ) mi
      JOIN matches m ON m.id = mi.match_id
      WHERE mi.batting_card::text ILIKE $1 OR mi.bowling_card::text ILIKE $1
      LIMIT 5
    `, [`%${player.name}%`]);

    const performances = [];
    for (const row of recentInnings.rows) {
      const batCard = Array.isArray(row.batting_card) ? row.batting_card : [];
      const bowlCard = Array.isArray(row.bowling_card) ? row.bowling_card : [];
      const myBat = batCard.find((b) => b.name && b.name.toLowerCase().includes(player.name.toLowerCase()));
      const myBowl = bowlCard.find((w) => w.name && w.name.toLowerCase().includes(player.name.toLowerCase()));

      performances.push({
        matchId: row.match_id,
        opponent: `${row.team_a_name} vs ${row.team_b_name}`,
        format: (row.format || "").toUpperCase(),
        batting: myBat ? { runs: myBat.runs, balls: myBat.balls, dismissal: myBat.dismissal } : null,
        bowling: myBowl ? {
          overs: formatCricketOvers(myBowl.overs, myBowl.balls),
          maidens: myBowl.maidens || 0,
          runs: myBowl.runs || 0,
          wickets: myBowl.wickets || 0,
        } : null,
      });
    }

    res.json({
      success: true,
      player: {
        id: player.id,
        name: player.name,
        age: player.age,
        nationality: player.nationality,
        country: formatCountry(player.nationality),
        archetype: player.archetype,
        battingStyle: player.batting_style,
        bowlingStyle: player.bowling_style,
        isWicketKeeper: player.is_wicket_keeper,
        overallRating: player.overall_rating,
        battingRating: player.batting_rating,
        bowlingRating: player.bowling_rating,
        fieldingRating: player.fielding_rating,
        captaincyRating: player.captaincy_rating,
        traits: {
          pressureHandler: player.pressure_handler,
          clutchPerformer: player.clutch_performer,
          bigMatchPlayer: player.big_match_player,
          chaseMaster: player.chase_master,
          deathOversExpert: player.death_overs_expert,
          consistent: player.consistent,
        },
        careerMatches: player.career_matches,
        careerInnings: player.career_innings,
        careerRuns: player.career_runs,
        careerBallsFaced: player.career_balls_faced,
        careerHundreds: player.career_hundreds,
        careerFifties: player.career_fifties,
        careerHighestScore: player.career_highest_score,
        careerWickets: player.career_wickets,
        careerBallsBowled: player.career_balls_bowled,
        careerRunsConceded: player.career_runs_conceded,
        careerOversBowled: formatCricketOvers(null, player.career_balls_bowled),
        careerBestFiguresWickets: player.career_best_figures_wickets,
        careerBestFiguresRuns: player.career_best_figures_runs,
        odiMatches: player.odi_matches,
        odiInnings: player.odi_innings,
        odiRuns: player.odi_runs,
        odiBallsFaced: player.odi_balls_faced,
        odiHundreds: player.odi_hundreds,
        odiFifties: player.odi_fifties,
        odiHighestScore: player.odi_highest_score,
        odiWickets: player.odi_wickets,
        odiOversBowled: formatCricketOvers(null, player.odi_balls_bowled),
        testMatches: player.test_matches,
        testInnings: player.test_innings,
        testRuns: player.test_runs,
        testBallsFaced: player.test_balls_faced,
        testHundreds: player.test_hundreds,
        testFifties: player.test_fifties,
        testHighestScore: player.test_highest_score,
        testWickets: player.test_wickets,
        testOversBowled: formatCricketOvers(null, player.test_balls_bowled),
      },
      recentPerformances: performances,
    });
  } catch (err) {
    console.error("Error in /api/players/:id:", err);
    res.status(500).json({ success: false, error: err.message || "Failed to load player profile" });
  }
});

// -----------------------------------------------------------------------------
// 7. Comprehensive Rankings & Leaderboards (/api/rankings)
// -----------------------------------------------------------------------------
app.get("/api/rankings", async (req, res) => {
  try {
    const scope = String(req.query.scope || "international").toLowerCase();
    const format = String(req.query.format || "odi").toLowerCase();

    // 1. International Rankings (From official snapshots)
    if (scope === "international") {
      let tourneyId = "INTL50";
      if (format === "t20") tourneyId = "INTL";
      else if (format === "test") tourneyId = "INTLTEST";

      const { rows } = await query(
        "SELECT * FROM intl_rankings_snapshots WHERE UPPER(tournament_id) = $1 ORDER BY rank ASC",
        [tourneyId]
      );

      const rankings = { batting: [], bowling: [], all_rounders: [], teams: [] };
      for (const r of rows) {
        if (rankings[r.category]) {
          rankings[r.category].push({
            rank: r.rank,
            name: r.entity_name,
            team: r.team_name,
            rating: r.rating,
            stat: r.primary_stat,
          });
        }
      }

      return res.json({
        success: true,
        scope: "international",
        format,
        tournamentId: tourneyId,
        rankings,
      });
    }

    // 2. Domestic Rankings (Aggregated by format)
    if (scope === "domestic") {
      let tourneyIds = [];
      if (format === "test" || format === "first_class") {
        tourneyIds = ["RT", "CC", "SFS", "CDC", "ASA", "HC", "WIC"];
      } else if (format === "odi" || format === "list_a") {
        tourneyIds = ["VHT", "C1C", "FT", "DPL", "GAK", "DJT", "ODC"];
      } else {
        tourneyIds = ["SMAT", "BBL", "TH", "C2C", "D2C", "A2C", "HK2C", "TCC", "VSL", "N2C", "R2C"];
      }

      const topBatters = await query(`
        SELECT tps.player_name, 
               MAX(p.nationality) as nationality,
               SUM(tps.runs) as total_runs, 
               SUM(tps.hundreds) as total_hundreds, 
               SUM(tps.fifties) as total_fifties,
               ROUND(SUM(tps.runs)::numeric / GREATEST(1, SUM(tps.dismissals))::numeric, 2) as batting_avg,
               ROUND((SUM(tps.runs)::numeric / GREATEST(1, SUM(tps.balls_faced))::numeric) * 100, 1) as strike_rate
        FROM tournament_player_stats tps
        LEFT JOIN players p ON p.id = tps.player_id
        WHERE UPPER(tps.tournament_id) = ANY($1::text[])
        GROUP BY tps.player_name
        ORDER BY total_runs DESC
        LIMIT 25
      `, [tourneyIds]);

      const topBowlers = await query(`
        SELECT tps.player_name, 
               MAX(p.nationality) as nationality,
               SUM(tps.wickets) as total_wickets, 
               SUM(tps.balls_bowled) as total_balls,
               SUM(tps.runs_conceded) as total_runs_conceded,
               ROUND((SUM(tps.runs_conceded)::numeric / GREATEST(1, SUM(tps.balls_bowled))::numeric) * 6, 2) as economy
        FROM tournament_player_stats tps
        LEFT JOIN players p ON p.id = tps.player_id
        WHERE UPPER(tps.tournament_id) = ANY($1::text[])
        GROUP BY tps.player_name
        ORDER BY total_wickets DESC
        LIMIT 25
      `, [tourneyIds]);

      const batting = topBatters.rows.map((r, idx) => ({
        rank: idx + 1,
        name: r.player_name,
        team: formatCountry(r.nationality),
        rating: Math.round(Number(r.total_runs) * 1.5 + Number(r.batting_avg || 0) * 8),
        stat: `${r.total_runs} Runs (${r.total_hundreds}x100, ${r.total_fifties}x50, Avg: ${r.batting_avg || 0})`,
      }));

      const bowling = topBowlers.rows.map((r, idx) => ({
        rank: idx + 1,
        name: r.player_name,
        team: formatCountry(r.nationality),
        rating: Math.round(Number(r.total_wickets) * 45 - Number(r.economy || 0) * 10),
        stat: `${r.total_wickets} Wkts (Econ: ${r.economy || 0}, ${formatCricketOvers(null, Number(r.total_balls))} ov)`,
      }));

      return res.json({
        success: true,
        scope: "domestic",
        format,
        rankings: { batting, bowling, all_rounders: [], teams: [] },
      });
    }

    // 3. Overall Rankings (Universal across all players)
    const overallBatters = await query(`
      SELECT id, name, nationality, overall_rating, batting_rating, archetype,
             (COALESCE(career_runs,0) + COALESCE(odi_runs,0) + COALESCE(test_runs,0)) as total_runs,
             (COALESCE(career_hundreds,0) + COALESCE(odi_hundreds,0) + COALESCE(test_hundreds,0)) as total_hundreds
      FROM players
      ORDER BY batting_rating DESC, total_runs DESC
      LIMIT 25
    `);

    const overallBowlers = await query(`
      SELECT id, name, nationality, overall_rating, bowling_rating, archetype,
             (COALESCE(career_wickets,0) + COALESCE(odi_wickets,0) + COALESCE(test_wickets,0)) as total_wickets
      FROM players
      ORDER BY bowling_rating DESC, total_wickets DESC
      LIMIT 25
    `);

    const overallAllRounders = await query(`
      SELECT id, name, nationality, overall_rating, batting_rating, bowling_rating, archetype,
             (COALESCE(career_runs,0) + COALESCE(odi_runs,0)) as total_runs,
             (COALESCE(career_wickets,0) + COALESCE(odi_wickets,0)) as total_wickets
      FROM players
      WHERE archetype IN ('batting_all_rounder', 'balanced_all_rounder', 'bowling_all_rounder')
      ORDER BY (batting_rating + bowling_rating) DESC
      LIMIT 25
    `);

    res.json({
      success: true,
      scope: "overall",
      rankings: {
        batting: overallBatters.rows.map((r, idx) => ({
          rank: idx + 1,
          name: r.name,
          team: formatCountry(r.nationality),
          rating: r.batting_rating,
          stat: `${Number(r.total_runs).toLocaleString()} Career Runs (${r.total_hundreds}x100)`,
        })),
        bowling: overallBowlers.rows.map((r, idx) => ({
          rank: idx + 1,
          name: r.name,
          team: formatCountry(r.nationality),
          rating: r.bowling_rating,
          stat: `${Number(r.total_wickets)} Career Wickets`,
        })),
        all_rounders: overallAllRounders.rows.map((r, idx) => ({
          rank: idx + 1,
          name: r.name,
          team: formatCountry(r.nationality),
          rating: Math.round((Number(r.batting_rating) + Number(r.bowling_rating)) / 2),
          stat: `${r.total_runs} Runs & ${r.total_wickets} Wkts (OVR: ${r.overall_rating})`,
        })),
        teams: [],
      },
    });
  } catch (err) {
    console.error("Error in /api/rankings:", err);
    res.status(500).json({ success: false, error: err.message || "Failed to load rankings" });
  }
});

// -----------------------------------------------------------------------------
// 8. Tournaments List (/api/tournaments)
// -----------------------------------------------------------------------------
app.get("/api/tournaments", async (req, res) => {
  try {
    const tourneysRes = await query("SELECT * FROM tournaments ORDER BY name ASC");
    const countsRes = await query(`
      SELECT tournament_id, count(*) as count
      FROM tournament_matches
      GROUP BY tournament_id
    `);

    const countMap = new Map();
    for (const r of countsRes.rows) {
      countMap.set(String(r.tournament_id).toUpperCase(), Number(r.count));
    }

    const categorized = tourneysRes.rows.map((t) => {
      const upper = t.id.toUpperCase();
      let category = "t20_leagues";
      if (
        ["ODIWC", "T20WC", "INTL", "INTL50", "INTLTEST", "WTC", "AC"].includes(upper) ||
        upper.startsWith("INTL")
      ) {
        category = "international";
      } else if (
        t.type === "test_match" ||
        ["RT", "CC", "SFS", "CDC", "ASA", "HC", "WIC"].includes(upper)
      ) {
        category = "first_class";
      } else if (
        t.type === "odi" ||
        ["VHT", "C1C", "FT", "DPL", "GAK", "DJT", "ODC"].includes(upper)
      ) {
        category = "list_a";
      }

      return {
        id: t.id,
        name: t.name,
        season: t.season,
        type: t.type,
        category,
        description: t.description,
        matchesCount: countMap.get(upper) || 0,
      };
    });

    res.json({ success: true, tournaments: categorized });
  } catch (err) {
    console.error("Error in /api/tournaments:", err);
    res.status(500).json({ success: false, error: err.message || "Failed to load tournaments" });
  }
});

// -----------------------------------------------------------------------------
// 9. Single Tournament Details (/api/tournaments/:id) - Standings, Leaders & Matches
// -----------------------------------------------------------------------------
app.get("/api/tournaments/:id", async (req, res) => {
  try {
    const tourneyId = String(req.params.id).trim();
    if (!tourneyId) return res.status(400).json({ success: false, error: "Invalid tournament ID" });

    const tourneyRes = await query("SELECT * FROM tournaments WHERE UPPER(id) = $1 LIMIT 1", [tourneyId.toUpperCase()]);
    const tourney = tourneyRes.rows[0];

    // Compute Standings with groups and stages
    const standingsData = await computeTournamentStandingsData(tourneyId);

    // Recent tournament matches
    const tourneyMatches = await query(`
      SELECT m.id, m.team_a_id, m.team_b_id, m.team_a_name, m.team_b_name,
             m.team_a_score, m.team_a_wickets, m.team_a_overs,
             m.team_b_score, m.team_b_wickets, m.team_b_overs,
             m.winner_team_id, m.winner_team_name, m.result_description, m.completed_at
      FROM matches m
      JOIN tournament_matches tm ON tm.match_id = m.id
      WHERE UPPER(tm.tournament_id) = $1 AND m.status = 'completed'
      ORDER BY m.id DESC
      LIMIT 20
    `, [tourneyId.toUpperCase()]);

    const tType = tourney ? tourney.type : "short";

    // Format-Aware Top Batters
    const topBattersRes = await query(`
      SELECT tps.player_id, tps.player_name, tps.matches,
             CASE 
               WHEN $1 = 'test_match' THEN COALESCE(tps.test_runs, tps.runs, 0)
               WHEN $1 = 'odi' THEN COALESCE(tps.odi_runs, tps.runs, 0)
               ELSE GREATEST(COALESCE(tps.runs,0), COALESCE(tps.odi_runs,0), COALESCE(tps.test_runs,0))
             END as runs,
             CASE 
               WHEN $1 = 'test_match' THEN COALESCE(tps.test_balls_faced, tps.balls_faced, 0)
               WHEN $1 = 'odi' THEN COALESCE(tps.odi_balls_faced, tps.balls_faced, 0)
               ELSE GREATEST(COALESCE(tps.balls_faced,0), COALESCE(tps.odi_balls_faced,0), COALESCE(tps.test_balls_faced,0))
             END as balls_faced,
             CASE 
               WHEN $1 = 'test_match' THEN COALESCE(tps.test_hundreds, tps.hundreds, 0)
               WHEN $1 = 'odi' THEN COALESCE(tps.odi_hundreds, tps.hundreds, 0)
               ELSE GREATEST(COALESCE(tps.hundreds,0), COALESCE(tps.odi_hundreds,0), COALESCE(tps.test_hundreds,0))
             END as hundreds,
             CASE 
               WHEN $1 = 'test_match' THEN COALESCE(tps.test_fifties, tps.fifties, 0)
               WHEN $1 = 'odi' THEN COALESCE(tps.odi_fifties, tps.fifties, 0)
               ELSE GREATEST(COALESCE(tps.fifties,0), COALESCE(tps.odi_fifties,0), COALESCE(tps.test_fifties,0))
             END as fifties
      FROM tournament_player_stats tps
      WHERE UPPER(tps.tournament_id) = $2
      ORDER BY runs DESC
      LIMIT 15
    `, [tType, tourneyId.toUpperCase()]);

    // Format-Aware Top Bowlers
    const topBowlersRes = await query(`
      SELECT tps.player_id, tps.player_name, tps.matches,
             CASE 
               WHEN $1 = 'test_match' THEN COALESCE(tps.test_wickets, tps.wickets, 0)
               WHEN $1 = 'odi' THEN COALESCE(tps.odi_wickets, tps.wickets, 0)
               ELSE GREATEST(COALESCE(tps.wickets,0), COALESCE(tps.odi_wickets,0), COALESCE(tps.test_wickets,0))
             END as wickets,
             CASE 
               WHEN $1 = 'test_match' THEN COALESCE(tps.test_balls_bowled, tps.balls_bowled, 0)
               WHEN $1 = 'odi' THEN COALESCE(tps.odi_balls_bowled, tps.balls_bowled, 0)
               ELSE GREATEST(COALESCE(tps.balls_bowled,0), COALESCE(tps.odi_balls_bowled,0), COALESCE(tps.test_balls_bowled,0))
             END as balls_bowled,
             CASE 
               WHEN $1 = 'test_match' THEN COALESCE(tps.test_runs_conceded, tps.runs_conceded, 0)
               WHEN $1 = 'odi' THEN COALESCE(tps.odi_runs_conceded, tps.runs_conceded, 0)
               ELSE GREATEST(COALESCE(tps.runs_conceded,0), COALESCE(tps.odi_runs_conceded,0), COALESCE(tps.test_runs_conceded,0))
             END as runs_conceded
      FROM tournament_player_stats tps
      WHERE UPPER(tps.tournament_id) = $2
      ORDER BY wickets DESC
      LIMIT 15
    `, [tType, tourneyId.toUpperCase()]);

    const formattedBatters = topBattersRes.rows.map((b, idx) => {
      const runs = Number(b.runs) || 0;
      const balls = Number(b.balls_faced) || 0;
      return {
        rank: idx + 1,
        id: b.player_id,
        name: b.player_name,
        matches: Number(b.matches) || 0,
        runs,
        balls,
        hundreds: Number(b.hundreds) || 0,
        fifties: Number(b.fifties) || 0,
        strikeRate: balls > 0 ? ((runs / balls) * 100).toFixed(1) : "0.0",
      };
    });

    const formattedBowlers = topBowlersRes.rows.map((w, idx) => {
      const wickets = Number(w.wickets) || 0;
      const balls = Number(w.balls_bowled) || 0;
      const runs = Number(w.runs_conceded) || 0;
      const oversNum = balls / 6;
      return {
        rank: idx + 1,
        id: w.player_id,
        name: w.player_name,
        matches: Number(w.matches) || 0,
        wickets,
        overs: formatCricketOvers(null, balls),
        runs,
        economy: oversNum > 0 ? (runs / oversNum).toFixed(2) : "0.00",
      };
    });

    const recentMatchesFormatted = tourneyMatches.rows.map((m) => ({
      id: m.id,
      teamAName: m.team_a_name,
      teamBName: m.team_b_name,
      teamAScore: m.team_a_score,
      teamAWickets: m.team_a_wickets,
      teamAOvers: formatCricketOvers(m.team_a_overs),
      teamBScore: m.team_b_score,
      teamBWickets: m.team_b_wickets,
      teamBOvers: formatCricketOvers(m.team_b_overs),
      winnerTeamName: m.winner_team_name,
      resultDescription: m.result_description,
      completedAt: m.completed_at,
    }));

    res.json({
      success: true,
      tournament: tourney || { id: tourneyId, name: tourneyId, season: "1", type: "short" },
      matchesCount: tourneyMatches.rows.length,
      isTest: Boolean(tourney?.type === "test_match"),
      hasGroups: standingsData.hasGroups,
      groups: standingsData.groups,
      groupRows: standingsData.groupRows,
      hasSuperStage: standingsData.hasSuperStage,
      superStageName: standingsData.superStageName,
      superStageRows: standingsData.superStageRows,
      superStageGroups: standingsData.superStageGroups,
      superStageGroupRows: standingsData.superStageGroupRows,
      superStageQualifyCount: 4,
      standings: standingsData.standings,
      topBatters: formattedBatters,
      topBowlers: formattedBowlers,
      recentMatches: recentMatchesFormatted,
    });
  } catch (err) {
    console.error("Error in /api/tournaments/:id:", err);
    res.status(500).json({ success: false, error: err.message || "Failed to load tournament data" });
  }
});

// -----------------------------------------------------------------------------
// 10. General Overview Stats (/api/overview)
// -----------------------------------------------------------------------------
app.get("/api/overview", async (req, res) => {
  try {
    const [pCount, mCount, tCount, trnCount, liveCount] = await Promise.all([
      query("SELECT count(*) as count FROM players"),
      query("SELECT count(*) as count FROM matches"),
      query("SELECT count(*) as count FROM teams"),
      query("SELECT count(*) as count FROM tournaments"),
      query("SELECT count(*) as count FROM active_match_states").catch(() => ({ rows: [{ count: 0 }] })),
    ]);

    res.json({
      success: true,
      liveMatchCount: Number(liveCount.rows[0]?.count || 0),
      totalPlayers: Number(pCount.rows[0]?.count || 0),
      totalMatches: Number(mCount.rows[0]?.count || 0),
      totalTeams: Number(tCount.rows[0]?.count || 0),
      totalTournaments: Number(trnCount.rows[0]?.count || 0),
    });
  } catch (err) {
    console.error("Error in /api/overview:", err);
    res.status(500).json({ success: false, error: err.message || "Failed to load overview" });
  }
});

// -----------------------------------------------------------------------------
// Static Files & Client-Side Routing
// -----------------------------------------------------------------------------
app.use(express.static(path.join(__dirname, "public")));

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// -----------------------------------------------------------------------------
// Start Server
// -----------------------------------------------------------------------------
const server = app.listen(port, () => {
  console.log(`🚀 Virtual Universe Web Platform running on port ${port}`);
  console.log(`🌐 http://localhost:${port}`);
});

process.on("SIGTERM", () => {
  console.log("SIGTERM received, closing HTTP server and database pool...");
  server.close(() => {
    pool.end();
  });
});
