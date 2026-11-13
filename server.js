import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import fs from "fs";
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
  console.warn("⚠️  DATABASE_URL environment variable is not defined. Please configure DATABASE_URL in your hosting provider settings.");
}

const isSslDisabled = process.env.DATABASE_SSL === "false" ||
  (dbUrl && (dbUrl.includes("localhost") || dbUrl.includes("sslmode=disable")));

const pool = new pg.Pool({
  connectionString: dbUrl,
  ssl: isSslDisabled ? false : { rejectUnauthorized: false },
  max: 5,
  idleTimeoutMillis: 15000,
  connectionTimeoutMillis: 10000,
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

function extractPlayerTraits(p) {
  if (!p) return {};
  return {
    // Fielding traits
    safeHands: Boolean(p.safe_hands),
    athleticFielder: Boolean(p.athletic_fielder),
    directHitSpecialist: Boolean(p.direct_hit_specialist),

    // Mental & Pressure traits
    bigMatchPlayer: Boolean(p.big_match_player),
    clutchPerformer: Boolean(p.clutch_performer),
    pressureSensitive: Boolean(p.pressure_sensitive),
    pressureHandler: Boolean(p.pressure_handler),
    consistent: Boolean(p.consistent),

    // Game Situation traits
    powerplayExpert: Boolean(p.powerplay_expert),
    middleOversSpecialist: Boolean(p.middle_overs_specialist),
    deathOversExpert: Boolean(p.death_overs_expert),
    chaseMaster: Boolean(p.chase_master),

    // Captaincy & Leadership traits
    masterTactician: Boolean(p.master_tactician),
    aggressiveLeader: Boolean(p.aggressive_leader),
    calmLeader: Boolean(p.calm_leader),
    inspirationalCaptain: Boolean(p.inspirational_captain),
    defensiveCaptain: Boolean(p.defensive_captain),
  };
}

const TRAIT_COLUMN_MAP = {
  safeHands: "safe_hands",
  athleticFielder: "athletic_fielder",
  directHitSpecialist: "direct_hit_specialist",
  bigMatchPlayer: "big_match_player",
  clutchPerformer: "clutch_performer",
  pressureSensitive: "pressure_sensitive",
  pressureHandler: "pressure_handler",
  consistent: "consistent",
  powerplayExpert: "powerplay_expert",
  middleOversSpecialist: "middle_overs_specialist",
  deathOversExpert: "death_overs_expert",
  chaseMaster: "chase_master",
  masterTactician: "master_tactician",
  aggressiveLeader: "aggressive_leader",
  calmLeader: "calm_leader",
  inspirationalCaptain: "inspirational_captain",
  defensiveCaptain: "defensive_captain",
};

// -----------------------------------------------------------------------------
// Tournament Standings Engine (Groups & Super Stages)
// -----------------------------------------------------------------------------
function computeStandingsFromMatches(teams, matches, inningsRows, isTest, matchFormatMap) {
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
  const relevantInnings = (inningsRows || []).filter((inn) => matchIdSet.has(inn.match_id || inn.matchId));

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
      let isWinnerA = false;
      if (m.winner_team_id === m.team_a_id) {
        isWinnerA = true;
      } else if (m.winner_team_id === m.team_b_id) {
        isWinnerA = false;
      } else {
        const winnerName = (m.winner_team_name || "").toLowerCase().trim();
        const aName = (m.team_a_name || "").toLowerCase().trim();
        isWinnerA = aName === winnerName || winnerName.includes(aName);
      }

      const winPts = isTest ? 12 : 2;

      if (isWinnerA) {
        if (teamA) { teamA.won++; teamA.points += winPts; teamA.form.push("W"); }
        if (teamB) { teamB.lost++; teamB.form.push("L"); }
      } else {
        if (teamB) { teamB.won++; teamB.points += winPts; teamB.form.push("W"); }
        if (teamA) { teamA.lost++; teamA.form.push("L"); }
      }
    }
  }

  // Calculate NRR or Quotient
  if (relevantInnings.length > 0) {
    if (isTest) {
      for (const inn of relevantInnings) {
        let batTeam = statsMap.get(inn.batting_team_id || inn.battingTeamId);
        let bowlTeam = statsMap.get(inn.bowling_team_id || inn.bowlingTeamId);
        if (!batTeam || !bowlTeam) {
          for (const t of statsMap.values()) {
            if (t.id === (inn.batting_team_id || inn.battingTeamId)) batTeam = t;
            if (t.id === (inn.bowling_team_id || inn.bowlingTeamId)) bowlTeam = t;
          }
        }
        if (batTeam && isAllowed(batTeam.id, batTeam.name)) {
          batTeam.runsScored += inn.total_runs || inn.totalRuns || 0;
          batTeam.wicketsLost += inn.total_wickets || inn.totalWickets || 0;
        }
        if (bowlTeam && isAllowed(bowlTeam.id, bowlTeam.name)) {
          bowlTeam.runsConceded += inn.total_runs || inn.totalRuns || 0;
          bowlTeam.wicketsTaken += inn.total_wickets || inn.totalWickets || 0;
        }
      }
      for (const t of statsMap.values()) {
        const wLost = Math.max(1, t.wicketsLost);
        const wTaken = Math.max(1, t.wicketsTaken);
        const batAvg = t.runsScored / wLost;
        const bowlAvg = t.runsConceded / wTaken;
        t.quotient = bowlAvg > 0 ? parseFloat((batAvg / bowlAvg).toFixed(3)) : 1.0;
      }
    } else {
      for (const inn of relevantInnings) {
        const innMatchId = inn.match_id || inn.matchId;
        const format = (matchFormatMap && matchFormatMap.get(innMatchId)) || "t20";
        if (format === "test" || format === "test_match") continue;

        const isHundred = format === "the_hundred";
        const ballsPerOver = isHundred ? 5.0 : 6.0;
        let maxOvers = 20.0;
        if (isHundred) maxOvers = 20.0;
        else if (format === "odi") maxOvers = 50.0;
        else if (format === "10_overs") maxOvers = 10.0;
        else if (format === "5_overs") maxOvers = 5.0;

        let batTeam = statsMap.get(inn.batting_team_id || inn.battingTeamId);
        let bowlTeam = statsMap.get(inn.bowling_team_id || inn.bowlingTeamId);
        if (!batTeam || !bowlTeam) {
          for (const t of statsMap.values()) {
            if (t.id === (inn.batting_team_id || inn.battingTeamId)) batTeam = t;
            if (t.id === (inn.bowling_team_id || inn.bowlingTeamId)) bowlTeam = t;
          }
        }

        const runs = inn.total_runs || inn.totalRuns || 0;
        const wkts = inn.total_wickets || inn.totalWickets || 0;
        const balls = inn.total_balls || inn.totalBalls || 0;
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
      nrr: typeof s.nrr === "number" ? (s.nrr >= 0 ? `+${s.nrr.toFixed(3)}` : s.nrr.toFixed(3)) : (s.nrr || "+0.000"),
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

  // Deduplicate matches by m.id to ensure accuracy
  const completedMatches = Array.from(new Map(matchesRes.rows.map((m) => [m.id, m])).values());

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

  const matchFormatMap = new Map(completedMatches.map((m) => [m.id, m.format || (tourney ? tourney.type : "t20")]));

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
    const clean = (tName || "").replace(/\s+/g, " ").trim();
    if (config.teamGroups[clean]) return config.teamGroups[clean];
    if (config.teamGroups[clean.toLowerCase()]) return config.teamGroups[clean.toLowerCase()];
    return null;
  };

  const isSuperTeam = (tId, tName) => {
    if (!config.superStageEnabled || !config.superStageConfig?.teams) return false;
    const sId = String(tId);
    const cleanName = (tName || "").replace(/\s+/g, " ").trim().toLowerCase();
    return config.superStageConfig.teams.some((t) => {
      const s = String(t).trim().toLowerCase();
      return s === sId || s === cleanName;
    });
  };

  const getSuperStageTeamSubgroup = (tId, tName) => {
    if (!config.superStageEnabled || !config.superStageConfig?.groups) return null;
    const sId = String(tId);
    const cleanName = (tName || "").replace(/\s+/g, " ").trim().toLowerCase();
    for (const [subgroup, teams] of Object.entries(config.superStageConfig.groups)) {
      if (Array.isArray(teams)) {
        const match = teams.some((t) => {
          const s = String(t).trim().toLowerCase();
          return s === sId || s === cleanName;
        });
        if (match) return subgroup;
      }
    }
    return null;
  };

  const getSuperStageUniqueGroups = () => {
    if (!config.superStageEnabled || !config.superStageConfig?.groups) return [];
    return Object.keys(config.superStageConfig.groups).filter((g) => g.trim().length > 0).sort((a, b) => a.localeCompare(b));
  };

  const getSuperStageGroupQualifyCount = (subgroup) => {
    if (subgroup && config.superStageConfig?.groupQualifyCounts) {
      const clean = subgroup.trim();
      if (config.superStageConfig.groupQualifyCounts[clean] !== undefined) {
        return config.superStageConfig.groupQualifyCounts[clean];
      }
      for (const [k, v] of Object.entries(config.superStageConfig.groupQualifyCounts)) {
        if (k.toLowerCase() === clean.toLowerCase()) return v;
      }
    }
    return config.superStageConfig?.qualifyCount ?? 4;
  };

  const hasSuper = Boolean(config.superStageEnabled);
  const superName = config.superStageConfig?.name || "Super Stage";

  let superStageRows = [];
  let superStageGroups = [];
  const superStageGroupRows = {};
  let groupRows = {};
  let overallRows = [];

  if (hasSuper) {
    let superTeams = allTeams.filter((t) => isSuperTeam(t.id, t.name));
    const nonSuperTeams = allTeams.filter((t) => !isSuperTeam(t.id, t.name));

    if (Array.isArray(config.superStageConfig?.teams)) {
      for (const configuredTeam of config.superStageConfig.teams) {
        const str = String(configuredTeam).trim();
        if (!str) continue;
        const alreadyPresent = superTeams.some(
          (st) => String(st.id) === str || st.name.toLowerCase() === str.toLowerCase()
        );
        if (!alreadyPresent) {
          superTeams.push({ id: /^\d+$/.test(str) ? Number(str) : -superTeams.length - 1, name: str, count: 0 });
        }
      }
    }

    // Determine Stage 1 cutoff matches per team
    let stage1K = 0;
    if (config.superStageConfig?.stage1MatchesPerTeam && config.superStageConfig.stage1MatchesPerTeam > 0) {
      stage1K = config.superStageConfig.stage1MatchesPerTeam;
    } else if (nonSuperTeams.length > 0) {
      stage1K = Math.max(...nonSuperTeams.map((t) => t.count));
    } else {
      const sorted = allTeams.map((t) => t.count).sort((a, b) => a - b);
      stage1K = sorted[0] || 0;
    }

    const teamStage1Count = new Map();
    const stage1Matches = [];
    const postStage1Matches = [];

    for (const m of completedMatches) {
      const a1 = teamStage1Count.get(m.team_a_id) || 0;
      const b1 = teamStage1Count.get(m.team_b_id) || 0;
      if (a1 < stage1K && b1 < stage1K) {
        teamStage1Count.set(m.team_a_id, a1 + 1);
        teamStage1Count.set(m.team_b_id, b1 + 1);
        stage1Matches.push(m);
      } else {
        postStage1Matches.push(m);
      }
    }

    overallRows = computeStandingsFromMatches(allTeams, stage1Matches, inningsRes.rows, isTest, matchFormatMap);
    const defaultQualify = config.qualifyCount ?? 4;
    overallRows.forEach((r, idx) => {
      r.isQualified = idx < defaultQualify;
    });

    if (config.groupsEnabled && uniqueGroups.length > 0) {
      for (const grp of uniqueGroups) {
        const teamsInGroup = allTeams.filter((t) => {
          const assigned = getTeamGroup(t.id, t.name);
          return assigned && assigned.toLowerCase() === grp.toLowerCase();
        });
        const gRows = computeStandingsFromMatches(teamsInGroup, stage1Matches, inningsRes.rows, isTest, matchFormatMap);
        const gQualify = config.groupQualifyCounts?.[grp] ?? 2;
        gRows.forEach((r, idx) => {
          r.isQualified = idx < gQualify;
        });
        groupRows[grp] = gRows;
      }
    }
    groupRows["Overall"] = overallRows;

    if (superTeams.length > 0) {
      const teamStage2TotalCounts = new Map();
      for (const m of postStage1Matches) {
        if (isSuperTeam(m.team_a_id, m.team_a_name) && isSuperTeam(m.team_b_id, m.team_b_name)) {
          teamStage2TotalCounts.set(m.team_a_id, (teamStage2TotalCounts.get(m.team_a_id) || 0) + 1);
          teamStage2TotalCounts.set(m.team_b_id, (teamStage2TotalCounts.get(m.team_b_id) || 0) + 1);
        }
      }

      const s2Counts = superTeams.map((t) => teamStage2TotalCounts.get(t.id) || 0).sort((a, b) => a - b);
      let stage2K = 0;
      if (s2Counts.length >= 4) {
        const regular = s2Counts.slice(0, Math.max(1, s2Counts.length - 2));
        stage2K = Math.max(...regular);
      } else if (s2Counts.length > 0) {
        stage2K = s2Counts[0] || 0;
      }

      const teamStage2Current = new Map();
      const stage2RoundRobinMatches = [];
      const superPlayoffMatches = [];

      for (const m of postStage1Matches) {
        if (isSuperTeam(m.team_a_id, m.team_a_name) && isSuperTeam(m.team_b_id, m.team_b_name)) {
          const a2 = teamStage2Current.get(m.team_a_id) || 0;
          const b2 = teamStage2Current.get(m.team_b_id) || 0;
          if (a2 < stage2K && b2 < stage2K) {
            teamStage2Current.set(m.team_a_id, a2 + 1);
            teamStage2Current.set(m.team_b_id, b2 + 1);
            stage2RoundRobinMatches.push(m);
          } else {
            superPlayoffMatches.push(m);
          }
        } else {
          superPlayoffMatches.push(m);
        }
      }

      // Points Carried Forward (PCF) calculation
      const carriedForwardMatches = [];
      if (config.superStageConfig?.carryForward) {
        for (const m of stage1Matches) {
          if (isSuperTeam(m.team_a_id, m.team_a_name) && isSuperTeam(m.team_b_id, m.team_b_name)) {
            if (config.groupsEnabled) {
              const grpA = getTeamGroup(m.team_a_id, m.team_a_name);
              const grpB = getTeamGroup(m.team_b_id, m.team_b_name);
              if (grpA && grpB && grpA.toLowerCase() === grpB.toLowerCase()) {
                carriedForwardMatches.push(m);
              }
            } else {
              carriedForwardMatches.push(m);
            }
          }
        }
      }

      const superStageAllMatches = [...carriedForwardMatches, ...stage2RoundRobinMatches];
      superStageRows = computeStandingsFromMatches(
        superTeams,
        superStageAllMatches,
        inningsRes.rows,
        isTest,
        matchFormatMap
      );

      const superQualify = config.superStageConfig?.qualifyCount ?? 4;
      superStageRows.forEach((r, idx) => {
        r.isQualified = idx < superQualify;
      });

      superStageGroups = getSuperStageUniqueGroups();
      if (superStageGroups.length > 0) {
        for (const sGrp of superStageGroups) {
          const teamsInSub = superTeams.filter((t) => {
            const sub = getSuperStageTeamSubgroup(t.id, t.name);
            return sub && sub.toLowerCase() === sGrp.toLowerCase();
          });
          const subRows = computeStandingsFromMatches(
            teamsInSub,
            superStageAllMatches,
            inningsRes.rows,
            isTest,
            matchFormatMap
          );
          const subQ = getSuperStageGroupQualifyCount(sGrp);
          subRows.forEach((r, idx) => {
            r.isQualified = idx < subQ;
          });
          superStageGroupRows[sGrp] = subRows;
        }
      }
      superStageGroupRows["Overall"] = superStageRows;
    }
  } else {
    // Standard single-stage round-robin match cutoff calculation
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

    overallRows = computeStandingsFromMatches(allTeams, roundRobinMatches, inningsRes.rows, isTest, matchFormatMap);
    const defaultQualify = config.qualifyCount ?? 4;
    overallRows.forEach((r, idx) => {
      r.isQualified = idx < defaultQualify;
    });

    if (config.groupsEnabled && uniqueGroups.length > 0) {
      for (const grp of uniqueGroups) {
        const teamsInGroup = allTeams.filter((t) => {
          const assigned = getTeamGroup(t.id, t.name);
          return assigned && assigned.toLowerCase() === grp.toLowerCase();
        });
        const gRows = computeStandingsFromMatches(teamsInGroup, roundRobinMatches, inningsRes.rows, isTest, matchFormatMap);
        const gQualify = config.groupQualifyCounts?.[grp] ?? 2;
        gRows.forEach((r, idx) => {
          r.isQualified = idx < gQualify;
        });
        groupRows[grp] = gRows;
      }
    }
    groupRows["Overall"] = overallRows;
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
// Discord Channel Name Cache & Resolver
// -----------------------------------------------------------------------------
const KNOWN_DISCORD_CHANNELS = {
  "1511374928857792612": "🏟️│ironwood-cricket-ground",
  "1511374988043747338": "🏟️│emerald-crest-stadium",
  "1511375104154533898": "🏟️│silverleaf-oval",
  "1511375274565042176": "🏟️│frostspire-stadium",
  "1511373730323103784": "🏟️│thundercrest-stadium",
  "1511374679145971824": "🏟️│nova-arena",
  "1511375155111133306": "🏟️│phoenix-field",
  "1511375317019656202": "🏟️│eclipse-oval",
  "1511375380617891910": "🏟️│titans-arena",
  "1511375435295100958": "🏟️│sunfire-cricket-ground",
  "1511375531382407210": "🏟️│dragonstone-oval",
  "1514689712969875456": "🎥│vcn-go",
  "1518976395173302404": "🎥│cricketverse-tv",
  "1518915787476303882": "📋│raw-stats-2",
  "1521243051438375003": "📋│results-1",
};

const discordChannelNameCache = new Map(Object.entries(KNOWN_DISCORD_CHANNELS));

async function resolveDiscordChannelName(channelId) {
  if (!channelId) return "#match-arena";
  const idStr = String(channelId).trim();
  if (discordChannelNameCache.has(idStr)) {
    return discordChannelNameCache.get(idStr);
  }

  const token = process.env.DISCORD_BOT_TOKEN || process.env.DISCORD_TOKEN;
  if (token) {
    try {
      const cleanToken = token.replace(/^['"]|['"]$/g, "").trim();
      const res = await fetch(`https://discord.com/api/v10/channels/${idStr}`, {
        headers: { Authorization: `Bot ${cleanToken}` },
      });
      if (res.ok) {
        const data = await res.json();
        if (data.name) {
          const formatted = data.name.startsWith("🏟️") || data.name.startsWith("🎥") || data.name.startsWith("📋")
            ? data.name
            : `#${data.name}`;
          discordChannelNameCache.set(idStr, formatted);
          return formatted;
        }
      }
    } catch {}
  }

  return `#channel-${idStr.slice(-4)}`;
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
        const teamAName = ms.teamAName || ms.teamA?.team?.name || "Team A";
        const teamBName = ms.teamBName || ms.teamB?.team?.name || "Team B";

        const battingTeamName = inn?.teamName || (ms.battingTeamSide === "B" ? teamBName : teamAName);
        const bowlingTeamName = battingTeamName === teamAName ? teamBName : teamAName;

        const striker = inn?.batters?.[inn.strikerIndex];
        const nonStriker = inn?.batters?.[inn.nonStrikerIndex];
        const bowler = inn?.currentBowler;
        const totalRuns = Number(inn?.totalRuns ?? 0);
        const totalBalls = Number(inn?.totalBalls ?? 0);
        const totalWickets = Number(inn?.totalWickets ?? 0);
        const totalOversMax = ms.totalOvers || 20;

        const crr = totalBalls > 0 ? ((totalRuns / totalBalls) * 6).toFixed(2) : "0.00";
        let rrr = null;
        if (ms.target && ms.currentInnings >= 1) {
          const runsNeeded = Math.max(0, ms.target - totalRuns);
          const ballsRemaining = Math.max(0, totalOversMax * 6 - totalBalls);
          rrr = ballsRemaining > 0 ? ((runsNeeded / ballsRemaining) * 6).toFixed(2) : "0.00";
        }

        // Determine scores & overs for both Team A and Team B
        const inns = Array.isArray(ms.innings) ? ms.innings : [];
        const inn0 = inns[0];
        const currentInningsIdx = Number(ms.currentInnings || 0);

        // Identify who batted first in innings 0
        let isTeamABattedFirst = true;
        if (inn0?.teamName) {
          const inn0Name = inn0.teamName.toLowerCase().trim();
          if (inn0Name === teamBName.toLowerCase().trim()) {
            isTeamABattedFirst = false;
          }
        } else if (ms.battingTeamSide === "B" && currentInningsIdx === 0) {
          isTeamABattedFirst = false;
        }

        let teamAScore = "";
        let teamAOvers = "";
        let teamAIsBatting = false;
        let teamAYetToBat = false;

        let teamBScore = "";
        let teamBOvers = "";
        let teamBIsBatting = false;
        let teamBYetToBat = false;

        if (currentInningsIdx === 0) {
          // In Innings 1:
          if (isTeamABattedFirst) {
            teamAIsBatting = true;
            teamAScore = `${totalRuns}/${totalWickets}`;
            teamAOvers = formatCricketOvers(null, totalBalls);

            teamBYetToBat = true;
            teamBScore = "Yet to bat";
            teamBOvers = "";
          } else {
            teamBIsBatting = true;
            teamBScore = `${totalRuns}/${totalWickets}`;
            teamBOvers = formatCricketOvers(null, totalBalls);

            teamAYetToBat = true;
            teamAScore = "Yet to bat";
            teamAOvers = "";
          }
        } else {
          // In Innings 2:
          if (isTeamABattedFirst) {
            // Team A finished batting in Innings 1
            teamAIsBatting = false;
            teamAYetToBat = false;
            const r0 = inn0?.totalRuns ?? (ms.target ? ms.target - 1 : 0);
            const w0 = inn0?.totalWickets ?? 0;
            const b0 = inn0?.totalBalls ?? 0;
            teamAScore = `${r0}/${w0}`;
            teamAOvers = `${formatCricketOvers(null, b0)} ov`;

            // Team B is currently batting in Innings 2
            teamBIsBatting = true;
            teamBYetToBat = false;
            teamBScore = `${totalRuns}/${totalWickets}`;
            teamBOvers = formatCricketOvers(null, totalBalls);
          } else {
            // Team B finished batting in Innings 1
            teamBIsBatting = false;
            teamBYetToBat = false;
            const r0 = inn0?.totalRuns ?? (ms.target ? ms.target - 1 : 0);
            const w0 = inn0?.totalWickets ?? 0;
            const b0 = inn0?.totalBalls ?? 0;
            teamBScore = `${r0}/${w0}`;
            teamBOvers = `${formatCricketOvers(null, b0)} ov`;

            // Team A is currently batting in Innings 2
            teamAIsBatting = true;
            teamAYetToBat = false;
            teamAScore = `${totalRuns}/${totalWickets}`;
            teamAOvers = formatCricketOvers(null, totalBalls);
          }
        }

        const channelName = await resolveDiscordChannelName(ms.channelId);

        liveMatches.push({
          matchId: ms.matchId,
          format: (ms.format || "cricket").toUpperCase().replace(/_/g, " "),
          pitchType: (ms.pitchType || "balanced").replace(/_/g, " "),
          stadiumName: ms.stadiumName || "Official Cricket Ground",
          weather: ms.weather || "clear",
          teamA: {
            name: teamAName,
            shortName: ms.teamA?.team?.shortName || teamAName.slice(0, 3).toUpperCase(),
            logoUrl: ms.teamA?.team?.logoUrl || null,
            score: teamAScore,
            overs: teamAOvers,
            isBatting: teamAIsBatting,
            yetToBat: teamAYetToBat,
          },
          teamB: {
            name: teamBName,
            shortName: ms.teamB?.team?.shortName || teamBName.slice(0, 3).toUpperCase(),
            logoUrl: ms.teamB?.team?.logoUrl || null,
            score: teamBScore,
            overs: teamBOvers,
            isBatting: teamBIsBatting,
            yetToBat: teamBYetToBat,
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
            channelName,
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
    const formatted = await Promise.all(rows.map(async (m) => {
      const channelName = await resolveDiscordChannelName(m.channel_id);
      return {
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
        stadiumName: m.stadium_name || "Official Cricket Ground",
        winnerTeamName: m.winner_team_name,
        resultDescription: m.result_description,
        playerOfMatchName: m.player_of_match_name,
        channel: {
          id: m.channel_id,
          name: channelName,
          url: `https://discord.com/channels/@me/${m.channel_id}`,
        },
        completedAt: m.completed_at,
      };
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

    // 1. Check active_match_states first for ongoing live match state
    let liveState = null;
    try {
      const activeRes = await query("SELECT state FROM active_match_states WHERE (state->>'matchId')::int = $1 LIMIT 1", [matchId]);
      if (activeRes.rows.length > 0) {
        liveState = activeRes.rows[0].state;
      }
    } catch (e) {
      // active_match_states query fallback
    }

    if (liveState && !liveState.isComplete) {
      const ms = liveState;
      const teamAName = ms.teamAName || ms.teamA?.team?.name || "Team A";
      const teamBName = ms.teamBName || ms.teamB?.team?.name || "Team B";
      const format = (ms.format || "t20").toLowerCase();
      const isHundred = format === "the_hundred";

      const rawInns = Array.isArray(ms.innings) ? [...ms.innings] : [];
      const currentInningsIdx = Number(ms.currentInnings || 0);
      if (ms.currentInningsState) {
        rawInns[currentInningsIdx] = ms.currentInningsState;
      }

      const formattedInnings = [];
      for (let idx = 0; idx < rawInns.length; idx++) {
        const inn = rawInns[idx];
        if (!inn) continue;

        const innNumber = idx + 1;
        const battingTeamName = inn.teamName || (innNumber === 1 ? teamAName : teamBName);

        const batCard = (inn.batters || [])
          .filter((b, bIdx) => (b.balls ?? 0) > 0 || b.isOut || bIdx === inn.strikerIndex || bIdx === inn.nonStrikerIndex)
          .map((b, bIdx) => {
            let dismissal = b.dismissal || "not out";
            if (!b.isOut) {
              if (bIdx === inn.strikerIndex) dismissal = "not out *";
              else dismissal = "not out";
            }
            return {
              name: b.name || "Batter",
              runs: Number(b.runs ?? 0),
              balls: Number(b.balls ?? 0),
              fours: Number(b.fours ?? 0),
              sixes: Number(b.sixes ?? 0),
              dismissal,
              strikeRate: (b.balls ?? 0) > 0 ? (((b.runs ?? 0) / b.balls) * 100).toFixed(2) : "0.00",
            };
          });

        const bowlCard = (inn.bowlers || [])
          .filter((w) => {
            const overs = Number(w.overs ?? 0);
            const balls = Number(w.oversBowled ?? w.balls ?? 0);
            const wkts = Number(w.wickets ?? 0);
            const runs = Number(w.runsConceded ?? w.runs ?? 0);
            return overs > 0 || balls > 0 || wkts > 0 || runs > 0;
          })
          .map((w) => {
            const balls = Number(w.oversBowled ?? w.balls ?? 0);
            const runs = Number(w.runsConceded ?? w.runs ?? 0);
            const wkts = Number(w.wickets ?? 0);
            const oversDisplay = formatCricketOvers(w.overs, balls);
            const economy = balls > 0 ? (((runs / balls) * (isHundred ? 5 : 6))).toFixed(2) : "0.00";
            return {
              name: w.name || w.bowlerName || "Bowler",
              overs: oversDisplay,
              maidens: Number(w.maidens ?? 0),
              runs,
              wickets: wkts,
              economy,
            };
          });

        formattedInnings.push({
          inningsNumber: innNumber,
          teamName: battingTeamName,
          battingTeamName,
          totalRuns: Number(inn.totalRuns ?? 0),
          totalWickets: Number(inn.totalWickets ?? 0),
          totalBalls: Number(inn.totalBalls ?? 0),
          overs: formatCricketOvers(null, inn.totalBalls),
          battingCard: batCard,
          bowlingCard: bowlCard,
        });
      }

      let equationDesc = `Live Match • Innings ${currentInningsIdx + 1} in progress`;
      if (ms.target && currentInningsIdx >= 1) {
        const innCurr = ms.currentInningsState || rawInns[currentInningsIdx];
        const rCurr = Number(innCurr?.totalRuns ?? 0);
        const needed = Math.max(0, ms.target - rCurr);
        equationDesc = `⚡ ${ms.battingTeam?.team?.name || "Batting team"} need ${needed} runs to win`;
      }

      const channelName = await resolveDiscordChannelName(ms.channelId);

      return res.json({
        success: true,
        match: {
          id: ms.matchId,
          format: (ms.format || "t20").toUpperCase().replace(/_/g, " "),
          teamAName,
          teamBName,
          stadiumName: ms.stadiumName || "Official Cricket Ground",
          pitchType: ms.pitchType || "balanced",
          weather: ms.weather || "clear",
          status: "live",
          resultDescription: equationDesc,
          channelName,
          channelUrl: `https://discord.com/channels/@me/${ms.channelId}`,
        },
        innings: formattedInnings,
        recentDeliveries: [],
      });
    }

    // 2. Completed matches lookup from DB
    const matchRes = await query("SELECT * FROM matches WHERE id = $1 LIMIT 1", [matchId]);
    if (matchRes.rows.length === 0) return res.status(404).json({ success: false, error: "Match not found" });

    const match = matchRes.rows[0];
    const innRes = await query("SELECT * FROM match_innings WHERE match_id = $1 ORDER BY innings_number ASC", [matchId]);

    const formattedInnings = innRes.rows.map((inn) => {
      const batCard = (inn.batting_card || []).map((b) => ({
        ...b,
        name: b.name || b.playerName || "Batter",
        runs: Number(b.runs ?? 0),
        balls: Number(b.balls ?? 0),
        fours: Number(b.fours ?? 0),
        sixes: Number(b.sixes ?? 0),
        dismissal: b.dismissal || (b.isOut === false ? "not out" : "out"),
        strikeRate: b.strikeRate != null ? b.strikeRate : (b.balls > 0 ? ((b.runs / b.balls) * 100).toFixed(2) : "0.00"),
      }));

      // Filter out bowlers who didn't bowl (0 overs, 0 balls, 0 wickets, 0 runs)
      const bowlCard = (inn.bowling_card || [])
        .filter((w) => {
          const overs = Number(w.overs ?? 0);
          const balls = Number(w.balls ?? w.ballsBowled ?? 0);
          const wickets = Number(w.wickets ?? 0);
          const runs = Number(w.runs ?? w.runsConceded ?? 0);
          return overs > 0 || balls > 0 || wickets > 0 || runs > 0;
        })
        .map((w) => ({
          ...w,
          name: w.name || w.bowlerName || "Bowler",
          overs: formatCricketOvers(w.overs, w.balls),
          maidens: Number(w.maidens ?? 0),
          runs: Number(w.runs ?? w.runsConceded ?? 0),
          wickets: Number(w.wickets ?? 0),
          economy: w.economy != null ? w.economy : (w.overs > 0 ? (w.runs / w.overs).toFixed(2) : "0.00"),
        }));

      const battingTeamName = inn.batting_team_id === match.team_a_id
        ? (match.team_a_name || "Team A")
        : inn.batting_team_id === match.team_b_id
        ? (match.team_b_name || "Team B")
        : (inn.batting_team_name || (inn.innings_number === 1 ? match.team_a_name : match.team_b_name) || `Innings ${inn.innings_number}`);

      return {
        ...inn,
        inningsNumber: inn.innings_number,
        teamName: battingTeamName,
        battingTeamName,
        totalRuns: Number(inn.total_runs ?? 0),
        totalWickets: Number(inn.total_wickets ?? 0),
        totalBalls: Number(inn.total_balls ?? 0),
        overs: formatCricketOvers(null, inn.total_balls),
        battingCard: batCard,
        bowlingCard: bowlCard,
      };
    });

    const deliveriesRes = await query("SELECT * FROM match_deliveries WHERE match_id = $1 ORDER BY id DESC LIMIT 30", [matchId]);

    const channelName = await resolveDiscordChannelName(match.channel_id);

    res.json({
      success: true,
      match: {
        ...match,
        teamAOvers: formatCricketOvers(match.team_a_overs),
        teamBOvers: formatCricketOvers(match.team_b_overs),
        channelName,
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
    if (trait && trait !== "All" && TRAIT_COLUMN_MAP[trait]) {
      conditions.push(`${TRAIT_COLUMN_MAP[trait]} = true`);
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
      orderClause = "ORDER BY (COALESCE(career_runs,0) + COALESCE(odi_runs,0) + COALESCE(test_runs,0)) DESC";
    } else if (sortBy === "wickets") {
      orderClause = "ORDER BY (COALESCE(career_wickets,0) + COALESCE(odi_wickets,0) + COALESCE(test_wickets,0)) DESC";
    } else if (sortBy === "batting") {
      orderClause = "ORDER BY batting_rating DESC";
    } else if (sortBy === "bowling") {
      orderClause = "ORDER BY bowling_rating DESC";
    } else if (sortBy === "centuries") {
      orderClause = "ORDER BY (COALESCE(career_hundreds,0) + COALESCE(odi_hundreds,0) + COALESCE(test_hundreds,0)) DESC";
    } else if (sortBy === "fifties") {
      orderClause = "ORDER BY (COALESCE(career_fifties,0) + COALESCE(odi_fifties,0) + COALESCE(test_fifties,0)) DESC";
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
      traits: extractPlayerTraits(p),
      stats: {
        matches: (p.career_matches || 0) + (p.odi_matches || 0) + (p.test_matches || 0),
        runs: (p.career_runs || 0) + (p.odi_runs || 0) + (p.test_runs || 0),
        wickets: (p.career_wickets || 0) + (p.odi_wickets || 0) + (p.test_wickets || 0),
        hundreds: (p.career_hundreds || 0) + (p.odi_hundreds || 0) + (p.test_hundreds || 0),
        fifties: (p.career_fifties || 0) + (p.odi_fifties || 0) + (p.test_fifties || 0),
        highestScore: Math.max(p.career_highest_score || 0, p.odi_highest_score || 0, p.test_highest_score || 0),
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

    const formatLabel = format === "short" ? "Short Formats (T20/T10)" : format === "odi" ? "ODI (50-Over)" : format === "test" ? "Test Matches" : "All Formats Combined";

    // Intelligent format- & role-aware cricket verdict
    const generateComparisonVerdict = (p1, p2, st1, st2, fmtLabel) => {
      const p1Bat = Number(p1.batting_rating) || 0;
      const p2Bat = Number(p2.batting_rating) || 0;
      const p1Bowl = Number(p1.bowling_rating) || 0;
      const p2Bowl = Number(p2.bowling_rating) || 0;
      const p1Ovr = Number(p1.overall_rating) || 0;
      const p2Ovr = Number(p2.overall_rating) || 0;

      const p1Runs = Number(st1.runs) || 0;
      const p2Runs = Number(st2.runs) || 0;
      const p1Avg = parseFloat(st1.battingAvg) || 0;
      const p2Avg = parseFloat(st2.battingAvg) || 0;

      const p1Wkts = Number(st1.wickets) || 0;
      const p2Wkts = Number(st2.wickets) || 0;
      const p1Econ = parseFloat(st1.economy) || 0;
      const p2Econ = parseFloat(st2.economy) || 0;

      const isP1Batter = p1Bat >= p1Bowl + 8;
      const isP2Batter = p2Bat >= p2Bowl + 8;
      const isP1Bowler = p1Bowl >= p1Bat + 8;
      const isP2Bowler = p2Bowl >= p2Bat + 8;

      // 1. Pure Batter vs Pure Bowler
      if ((isP1Batter && isP2Bowler) || (isP1Bowler && isP2Batter)) {
        const batP = isP1Batter ? p1 : p2;
        const batS = isP1Batter ? st1 : st2;
        const batR = isP1Batter ? p1Bat : p2Bat;
        const bowlP = isP1Bowler ? p1 : p2;
        const bowlS = isP1Bowler ? st1 : st2;
        const bowlR = isP1Bowler ? p1Bowl : p2Bowl;
        return `Contrasting Masterclasses — ${batP.name} commands the batting department (${batR} BAT, ${batS.runs.toLocaleString()} runs @ ${batS.battingAvg} avg), while ${bowlP.name} dominates with the ball (${bowlR} BOWL, ${bowlS.wickets} wkts @ ${bowlS.economy} econ).`;
      }

      // 2. Both primarily Batters
      if (isP1Batter && isP2Batter) {
        if (p1Bat >= p2Bat + 3 || (p1Bat >= p2Bat && p1Runs > p2Runs * 1.25)) {
          const edge = p1Avg > p2Avg && p1Avg > 0 ? `higher average (${st1.battingAvg} vs ${st2.battingAvg})` : `greater run volume (${st1.runs.toLocaleString()} vs ${st2.runs.toLocaleString()})`;
          return `${p1.name} holds the definitive batting edge in ${fmtLabel} (${p1Bat} vs ${p2Bat} BAT) with ${edge}.`;
        }
        if (p2Bat >= p1Bat + 3 || (p2Bat >= p1Bat && p2Runs > p1Runs * 1.25)) {
          const edge = p2Avg > p1Avg && p2Avg > 0 ? `higher average (${st2.battingAvg} vs ${st1.battingAvg})` : `greater run volume (${st2.runs.toLocaleString()} vs ${st1.runs.toLocaleString()})`;
          return `${p2.name} holds the definitive batting edge in ${fmtLabel} (${p2Bat} vs ${p1Bat} BAT) with ${edge}.`;
        }
        if (Math.abs(p1Bat - p2Bat) <= 2) {
          if (p1Runs > p2Runs && p2Avg > p1Avg) {
            return `Close batting rivalry — ${p1.name} leads in career volume (${st1.runs.toLocaleString()} runs), while ${p2.name} holds higher consistency (${st2.battingAvg} avg).`;
          }
          if (p2Runs > p1Runs && p1Avg > p2Avg) {
            return `Close batting rivalry — ${p2.name} leads in career volume (${st2.runs.toLocaleString()} runs), while ${p1.name} holds higher consistency (${st1.battingAvg} avg).`;
          }
          return `${p1.name} and ${p2.name} are evenly matched run-scorers (${p1Bat} vs ${p2Bat} BAT) in ${fmtLabel}.`;
        }
      }

      // 3. Both primarily Bowlers
      if (isP1Bowler && isP2Bowler) {
        if (p1Bowl >= p2Bowl + 3 || (p1Bowl >= p2Bowl && p1Wkts > p2Wkts * 1.25)) {
          const edge = p1Econ > 0 && p1Econ < p2Econ ? `stingier economy (${st1.economy} vs ${st2.economy})` : `higher wicket tally (${st1.wickets} vs ${st2.wickets})`;
          return `${p1.name} commands the bowling duel in ${fmtLabel} (${p1Bowl} vs ${p2Bowl} BOWL) with ${edge}.`;
        }
        if (p2Bowl >= p1Bowl + 3 || (p2Bowl >= p1Bowl && p2Wkts > p1Wkts * 1.25)) {
          const edge = p2Econ > 0 && p2Econ < p1Econ ? `stingier economy (${st2.economy} vs ${st1.economy})` : `higher wicket tally (${st2.wickets} vs ${st1.wickets})`;
          return `${p2.name} commands the bowling duel in ${fmtLabel} (${p2Bowl} vs ${p1Bowl} BOWL) with ${edge}.`;
        }
        if (Math.abs(p1Bowl - p2Bowl) <= 2) {
          return `Intense bowling showdown — ${p1.name} (${st1.wickets} wkts, ${st1.economy} econ) and ${p2.name} (${st2.wickets} wkts, ${st2.economy} econ) share near-identical strike power.`;
        }
      }

      // 4. All-Rounder / General Overall Advantage
      if (p1Ovr > p2Ovr + 2) {
        const primaryWeapon = p1Bat > p2Bat ? "batting versatility" : "bowling control";
        return `${p1.name} claims the overall edge (${p1Ovr} vs ${p2Ovr} OVR), bolstered by stronger ${primaryWeapon}.`;
      }
      if (p2Ovr > p1Ovr + 2) {
        const primaryWeapon = p2Bat > p1Bat ? "batting versatility" : "bowling control";
        return `${p2.name} claims the overall edge (${p2Ovr} vs ${p1Ovr} OVR), bolstered by stronger ${primaryWeapon}.`;
      }

      // 5. Evenly matched
      return `Evenly Matched Contenders — ${p1.name} (${p1Ovr} OVR) and ${p2.name} (${p2Ovr} OVR) share equal prestige in ${fmtLabel}.`;
    };

    const verdict = generateComparisonVerdict(player1, player2, s1, s2, formatLabel);

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
        traits: extractPlayerTraits(player1),
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
        traits: extractPlayerTraits(player2),
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

    const calcBatAvg = (runs, inn, no) => {
      const dismissals = Math.max(0, (Number(inn) || 0) - (Number(no) || 0));
      if (dismissals === 0) return (Number(runs) || 0) > 0 ? `${Number(runs)}.00*` : "-";
      return ((Number(runs) || 0) / dismissals).toFixed(2);
    };

    const calcBowlAvg = (runsConceded, wickets) => {
      const wkts = Number(wickets) || 0;
      if (wkts === 0) return "-";
      return ((Number(runsConceded) || 0) / wkts).toFixed(2);
    };

    const calcSR = (runs, balls) => {
      const b = Number(balls) || 0;
      if (b === 0) return "-";
      return (((Number(runs) || 0) / b) * 100).toFixed(1);
    };

    const calcEcon = (runsConceded, ballsBowled) => {
      const b = Number(ballsBowled) || 0;
      if (b === 0) return "-";
      return (((Number(runsConceded) || 0) / b) * 6).toFixed(2);
    };

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
        traits: extractPlayerTraits(player),
        careerMatches: player.career_matches,
        careerInnings: player.career_innings,
        careerRuns: player.career_runs,
        careerBallsFaced: player.career_balls_faced,
        careerHundreds: player.career_hundreds,
        careerFifties: player.career_fifties,
        careerHighestScore: player.career_highest_score,
        careerBattingAvg: calcBatAvg(player.career_runs, player.career_innings, player.career_not_outs),
        careerBowlingAvg: calcBowlAvg(player.career_runs_conceded, player.career_wickets),
        careerStrikeRate: calcSR(player.career_runs, player.career_balls_faced),
        careerEconomy: calcEcon(player.career_runs_conceded, player.career_balls_bowled),
        careerWickets: player.career_wickets,
        careerBallsBowled: player.career_balls_bowled,
        careerRunsConceded: player.career_runs_conceded,
        careerOversBowled: formatCricketOvers(null, player.career_balls_bowled),
        careerBestFiguresWickets: player.career_best_figures_wickets || 0,
        careerBestFiguresRuns: player.career_best_figures_runs || 0,

        odiMatches: player.odi_matches || 0,
        odiInnings: player.odi_innings || 0,
        odiRuns: player.odi_runs || 0,
        odiBallsFaced: player.odi_balls_faced || 0,
        odiHundreds: player.odi_hundreds || 0,
        odiFifties: player.odi_fifties || 0,
        odiHighestScore: player.odi_highest_score || 0,
        odiBattingAvg: calcBatAvg(player.odi_runs, player.odi_innings, player.odi_not_outs),
        odiBowlingAvg: calcBowlAvg(player.odi_runs_conceded, player.odi_wickets),
        odiStrikeRate: calcSR(player.odi_runs, player.odi_balls_faced),
        odiEconomy: calcEcon(player.odi_runs_conceded, player.odi_balls_bowled),
        odiWickets: player.odi_wickets || 0,
        odiOversBowled: formatCricketOvers(null, player.odi_balls_bowled || 0),
        odiBestFiguresWickets: player.odi_best_figures_wickets || 0,
        odiBestFiguresRuns: player.odi_best_figures_runs || 0,

        testMatches: player.test_matches || 0,
        testInnings: player.test_innings || 0,
        testRuns: player.test_runs || 0,
        testBallsFaced: player.test_balls_faced || 0,
        testHundreds: player.test_hundreds || 0,
        testFifties: player.test_fifties || 0,
        testHighestScore: player.test_highest_score || 0,
        testBattingAvg: calcBatAvg(player.test_runs, player.test_innings, player.test_not_outs),
        testBowlingAvg: calcBowlAvg(player.test_runs_conceded, player.test_wickets),
        testStrikeRate: calcSR(player.test_runs, player.test_balls_faced),
        testEconomy: calcEcon(player.test_runs_conceded, player.test_balls_bowled),
        testWickets: player.test_wickets || 0,
        testOversBowled: formatCricketOvers(null, player.test_balls_bowled || 0),
        testBestFiguresWickets: player.test_best_figures_wickets || 0,
        testBestFiguresRuns: player.test_best_figures_runs || 0,
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

    // 1. International Rankings (From official snapshots: INTL50, INTL, INTLTEST)
    if (scope === "international") {
      let tourneyId = "INTL50";
      let runsCol = "odi_runs";
      let wktsCol = "odi_wickets";
      let matchesCol = "odi_matches";
      let innCol = "odi_innings";
      let hsCol = "odi_highest_score";
      let hundredsCol = "odi_hundreds";
      let fiftiesCol = "odi_fifties";
      let ballsFacedCol = "odi_balls_faced";
      let notOutsCol = "odi_not_outs";
      let ballsBowledCol = "odi_balls_bowled";
      let runsConcededCol = "odi_runs_conceded";
      let bbiWCol = "odi_best_figures_wickets";
      let bbiRCol = "odi_best_figures_runs";

      if (format === "t20") {
        tourneyId = "INTL";
        runsCol = "career_runs";
        wktsCol = "career_wickets";
        matchesCol = "career_matches";
        innCol = "career_innings";
        hsCol = "career_highest_score";
        hundredsCol = "career_hundreds";
        fiftiesCol = "career_fifties";
        ballsFacedCol = "career_balls_faced";
        notOutsCol = "career_not_outs";
        ballsBowledCol = "career_balls_bowled";
        runsConcededCol = "career_runs_conceded";
        bbiWCol = "career_best_figures_wickets";
        bbiRCol = "career_best_figures_runs";
      } else if (format === "test") {
        tourneyId = "INTLTEST";
        runsCol = "test_runs";
        wktsCol = "test_wickets";
        matchesCol = "test_matches";
        innCol = "test_innings";
        hsCol = "test_highest_score";
        hundredsCol = "test_hundreds";
        fiftiesCol = "test_fifties";
        ballsFacedCol = "test_balls_faced";
        notOutsCol = "test_not_outs";
        ballsBowledCol = "test_balls_bowled";
        runsConcededCol = "test_runs_conceded";
        bbiWCol = "test_best_figures_wickets";
        bbiRCol = "test_best_figures_runs";
      }

      const snapshotRows = await query(
        "SELECT * FROM intl_rankings_snapshots WHERE UPPER(tournament_id) = $1 ORDER BY rank ASC",
        [tourneyId]
      );

      const rankings = { batting: [], bowling: [], all_rounders: [], teams: [] };
      for (const r of snapshotRows.rows) {
        if (rankings[r.category]) {
          rankings[r.category].push({
            rank: r.rank,
            id: r.entity_id ? Number(r.entity_id) : null,
            name: r.entity_name,
            team: r.team_name,
            rating: r.rating,
            stat: r.primary_stat,
          });
        }
      }

      // Statistical Leaderboards (Raw numerical runs, wickets, averages, etc.)
      const [batLeadersRes, bowlLeadersRes, hsLeadersRes, bbiLeadersRes] = await Promise.all([
        query(`
          SELECT id, name, nationality, overall_rating, batting_rating, bowling_rating,
                 ${runsCol} as runs, ${matchesCol} as matches, ${innCol} as innings,
                 ${hsCol} as highest_score, ${hundredsCol} as hundreds, ${fiftiesCol} as fifties, ${ballsFacedCol} as balls_faced,
                 ROUND(${runsCol}::numeric / GREATEST(1, (${innCol} - ${notOutsCol}))::numeric, 2) as batting_avg,
                 ROUND((${runsCol}::numeric / GREATEST(1, ${ballsFacedCol})::numeric) * 100, 1) as strike_rate
          FROM players
          WHERE ${runsCol} > 0
          ORDER BY runs DESC
          LIMIT 25
        `),
        query(`
          SELECT id, name, nationality, overall_rating, batting_rating, bowling_rating,
                 ${wktsCol} as wickets, ${matchesCol} as matches,
                 ${ballsBowledCol} as balls_bowled, ${runsConcededCol} as runs_conceded,
                 ${bbiWCol} as best_wickets, ${bbiRCol} as best_runs,
                 ROUND((${runsConcededCol}::numeric / GREATEST(1, ${ballsBowledCol})::numeric) * 6, 2) as economy,
                 ROUND(${runsConcededCol}::numeric / GREATEST(1, ${wktsCol})::numeric, 2) as bowling_avg
          FROM players
          WHERE ${wktsCol} > 0
          ORDER BY wickets DESC
          LIMIT 25
        `),
        query(`
          SELECT id, name, nationality, overall_rating, batting_rating, bowling_rating,
                 ${hsCol} as score, ${runsCol} as runs,
                 ${hundredsCol} as hundreds, ${fiftiesCol} as fifties, ${matchesCol} as matches
          FROM players
          WHERE ${hsCol} > 0
          ORDER BY score DESC
          LIMIT 25
        `),
        query(`
          SELECT id, name, nationality, overall_rating, batting_rating, bowling_rating,
                 ${bbiWCol} as best_wickets, ${bbiRCol} as best_runs,
                 ${wktsCol} as wickets, ${matchesCol} as matches
          FROM players
          WHERE ${bbiWCol} > 0
          ORDER BY best_wickets DESC, best_runs ASC
          LIMIT 25
        `),
      ]);

      const formatLeaderBatters = (rows) => rows.map((r, idx) => ({
        rank: idx + 1,
        id: r.id,
        name: r.name,
        country: formatCountry(r.nationality),
        rating: Number(r.batting_rating || r.overall_rating || 0),
        matches: Number(r.matches) || 0,
        innings: Number(r.innings) || 0,
        runs: Number(r.runs) || 0,
        highestScore: Number(r.highest_score) || 0,
        battingAvg: r.batting_avg || "0.00",
        strikeRate: r.strike_rate || "0.0",
        hundreds: Number(r.hundreds) || 0,
        fifties: Number(r.fifties) || 0,
      }));

      const formatLeaderBowlers = (rows) => rows.map((r, idx) => ({
        rank: idx + 1,
        id: r.id,
        name: r.name,
        country: formatCountry(r.nationality),
        rating: Number(r.bowling_rating || r.overall_rating || 0),
        matches: Number(r.matches) || 0,
        wickets: Number(r.wickets) || 0,
        overs: formatCricketOvers(null, Number(r.balls_bowled) || 0),
        runsConceded: Number(r.runs_conceded) || 0,
        economy: r.economy || "0.00",
        bowlingAvg: r.bowling_avg || "0.00",
        bestBowling: (r.best_wickets > 0 || r.best_runs > 0) ? `${r.best_wickets || 0}/${r.best_runs || 0}` : "-",
      }));

      const mostRuns = formatLeaderBatters(batLeadersRes.rows);
      const mostWickets = formatLeaderBowlers(bowlLeadersRes.rows);

      const highestScores = hsLeadersRes.rows.map((r, idx) => ({
        rank: idx + 1,
        id: r.id,
        name: r.name,
        country: formatCountry(r.nationality),
        rating: Number(r.batting_rating || r.overall_rating || 0),
        score: Number(r.score) || 0,
        runs: Number(r.runs) || 0,
        hundreds: Number(r.hundreds) || 0,
        fifties: Number(r.fifties) || 0,
        matches: Number(r.matches) || 0,
      }));

      const bestBowling = bbiLeadersRes.rows.map((r, idx) => ({
        rank: idx + 1,
        id: r.id,
        name: r.name,
        country: formatCountry(r.nationality),
        rating: Number(r.bowling_rating || r.overall_rating || 0),
        bestBowling: (r.best_wickets > 0 || r.best_runs > 0) ? `${r.best_wickets || 0}/${r.best_runs || 0}` : "-",
        wickets: Number(r.wickets) || 0,
        matches: Number(r.matches) || 0,
      }));

      return res.json({
        success: true,
        scope: "international",
        format,
        tournamentId: tourneyId,
        rankings,
        leaderboards: {
          orangeCap: mostRuns.slice(0, 5),
          purpleCap: mostWickets.slice(0, 5),
          mostRuns,
          mostWickets,
          highestScores,
          bestBowling,
        },
      });
    }

    // 2. Domestic Rankings & Leaderboards (Aggregated by format)
    if (scope === "domestic") {
      let hsCol = "career_highest_score";
      let bbiWCol = "career_best_figures_wickets";
      let bbiRCol = "career_best_figures_runs";
      let tourneyCondition = "type = 'short' AND UPPER(id) NOT IN ('INTL', 'T20WC', 'EXH', 'EXH20')";
      let runsExpr = "COALESCE(tps.runs, 0)";
      let matchesExpr = "COALESCE(tps.matches, 0)";
      let hundredsExpr = "COALESCE(tps.hundreds, 0)";
      let fiftiesExpr = "COALESCE(tps.fifties, 0)";
      let dismissalsExpr = "COALESCE(tps.dismissals, 0)";
      let ballsFacedExpr = "COALESCE(tps.balls_faced, 0)";
      let wicketsExpr = "COALESCE(tps.wickets, 0)";
      let ballsBowledExpr = "COALESCE(tps.balls_bowled, 0)";
      let runsConcededExpr = "COALESCE(tps.runs_conceded, 0)";

      if (format === "test" || format === "first_class") {
        hsCol = "test_highest_score";
        bbiWCol = "test_best_figures_wickets";
        bbiRCol = "test_best_figures_runs";
        tourneyCondition = "type = 'test_match' AND UPPER(id) NOT IN ('INTLTEST', 'WTC')";
        runsExpr = "COALESCE(NULLIF(tps.test_runs, 0), tps.runs, 0)";
        matchesExpr = "COALESCE(NULLIF(tps.test_matches, 0), tps.matches, 0)";
        hundredsExpr = "COALESCE(NULLIF(tps.test_hundreds, 0), tps.hundreds, 0)";
        fiftiesExpr = "COALESCE(NULLIF(tps.test_fifties, 0), tps.fifties, 0)";
        dismissalsExpr = "COALESCE(NULLIF(GREATEST(0, tps.test_innings - tps.test_not_outs), 0), tps.dismissals, 0)";
        ballsFacedExpr = "COALESCE(NULLIF(tps.test_balls_faced, 0), tps.balls_faced, 0)";
        wicketsExpr = "COALESCE(NULLIF(tps.test_wickets, 0), tps.wickets, 0)";
        ballsBowledExpr = "COALESCE(NULLIF(tps.test_balls_bowled, 0), tps.balls_bowled, 0)";
        runsConcededExpr = "COALESCE(NULLIF(tps.test_runs_conceded, 0), tps.runs_conceded, 0)";
      } else if (format === "odi" || format === "list_a") {
        hsCol = "odi_highest_score";
        bbiWCol = "odi_best_figures_wickets";
        bbiRCol = "odi_best_figures_runs";
        tourneyCondition = "type = 'odi' AND UPPER(id) NOT IN ('INTL50', 'INTL50_S2', 'ODIWC', 'EXH50')";
        runsExpr = "COALESCE(NULLIF(tps.odi_runs, 0), tps.runs, 0)";
        matchesExpr = "COALESCE(NULLIF(tps.odi_matches, 0), tps.matches, 0)";
        hundredsExpr = "COALESCE(NULLIF(tps.odi_hundreds, 0), tps.hundreds, 0)";
        fiftiesExpr = "COALESCE(NULLIF(tps.odi_fifties, 0), tps.fifties, 0)";
        dismissalsExpr = "COALESCE(NULLIF(GREATEST(0, tps.odi_innings - tps.odi_not_outs), 0), tps.dismissals, 0)";
        ballsFacedExpr = "COALESCE(NULLIF(tps.odi_balls_faced, 0), tps.balls_faced, 0)";
        wicketsExpr = "COALESCE(NULLIF(tps.odi_wickets, 0), tps.wickets, 0)";
        ballsBowledExpr = "COALESCE(NULLIF(tps.odi_balls_bowled, 0), tps.balls_bowled, 0)";
        runsConcededExpr = "COALESCE(NULLIF(tps.odi_runs_conceded, 0), tps.runs_conceded, 0)";
      }

      const [topBatters, topBowlers, hsRes, bbiRes] = await Promise.all([
        query(`
          SELECT tps.player_id as id, tps.player_name as name, 
                 MAX(p.nationality) as nationality,
                 MAX(p.overall_rating) as overall_rating,
                 MAX(p.batting_rating) as batting_rating,
                 MAX(p.bowling_rating) as bowling_rating,
                 SUM(${runsExpr}) as runs, 
                 SUM(${matchesExpr}) as matches,
                 MAX(p.${hsCol}) as highest_score,
                 SUM(${hundredsExpr}) as total_hundreds, 
                 SUM(${fiftiesExpr}) as total_fifties,
                 ROUND(SUM(${runsExpr})::numeric / GREATEST(1, SUM(${dismissalsExpr}))::numeric, 2) as batting_avg,
                 ROUND((SUM(${runsExpr})::numeric / GREATEST(1, SUM(${ballsFacedExpr}))::numeric) * 100, 1) as strike_rate
          FROM tournament_player_stats tps
          LEFT JOIN players p ON p.id = tps.player_id
          WHERE UPPER(tps.tournament_id) IN (SELECT UPPER(id) FROM tournaments WHERE ${tourneyCondition})
          GROUP BY tps.player_id, tps.player_name
          ORDER BY runs DESC
          LIMIT 25
        `),
        query(`
          SELECT tps.player_id as id, tps.player_name as name, 
                 MAX(p.nationality) as nationality,
                 MAX(p.overall_rating) as overall_rating,
                 MAX(p.batting_rating) as batting_rating,
                 MAX(p.bowling_rating) as bowling_rating,
                 SUM(${wicketsExpr}) as wickets, 
                 SUM(${matchesExpr}) as matches,
                 SUM(${ballsBowledExpr}) as balls_bowled,
                 SUM(${runsConcededExpr}) as runs_conceded,
                 MAX(p.${bbiWCol}) as best_wickets,
                 MIN(CASE WHEN p.${bbiRCol} > 0 THEN p.${bbiRCol} ELSE 999 END) as best_runs,
                 ROUND((SUM(${runsConcededExpr})::numeric / GREATEST(1, SUM(${ballsBowledExpr}))::numeric) * 6, 2) as economy,
                 ROUND(SUM(${runsConcededExpr})::numeric / GREATEST(1, SUM(${wicketsExpr}))::numeric, 2) as bowling_avg
          FROM tournament_player_stats tps
          LEFT JOIN players p ON p.id = tps.player_id
          WHERE UPPER(tps.tournament_id) IN (SELECT UPPER(id) FROM tournaments WHERE ${tourneyCondition})
          GROUP BY tps.player_id, tps.player_name
          ORDER BY wickets DESC
          LIMIT 25
        `),
        query(`
          SELECT tps.player_id as id, tps.player_name as name,
                 MAX(p.nationality) as nationality,
                 MAX(p.overall_rating) as overall_rating,
                 MAX(p.batting_rating) as batting_rating,
                 MAX(p.${hsCol}) as score,
                 SUM(${runsExpr}) as runs,
                 SUM(${hundredsExpr}) as hundreds,
                 SUM(${fiftiesExpr}) as fifties,
                 SUM(${matchesExpr}) as matches
          FROM tournament_player_stats tps
          LEFT JOIN players p ON p.id = tps.player_id
          WHERE UPPER(tps.tournament_id) IN (SELECT UPPER(id) FROM tournaments WHERE ${tourneyCondition})
            AND p.${hsCol} > 0
          GROUP BY tps.player_id, tps.player_name
          ORDER BY score DESC
          LIMIT 25
        `),
        query(`
          SELECT tps.player_id as id, tps.player_name as name,
                 MAX(p.nationality) as nationality,
                 MAX(p.overall_rating) as overall_rating,
                 MAX(p.bowling_rating) as bowling_rating,
                 MAX(p.${bbiWCol}) as best_wickets,
                 MIN(CASE WHEN p.${bbiRCol} > 0 THEN p.${bbiRCol} ELSE 999 END) as best_runs,
                 SUM(${wicketsExpr}) as wickets,
                 SUM(${matchesExpr}) as matches
          FROM tournament_player_stats tps
          LEFT JOIN players p ON p.id = tps.player_id
          WHERE UPPER(tps.tournament_id) IN (SELECT UPPER(id) FROM tournaments WHERE ${tourneyCondition})
            AND p.${bbiWCol} > 0
          GROUP BY tps.player_id, tps.player_name
          ORDER BY best_wickets DESC, best_runs ASC
          LIMIT 25
        `),
      ]);

      const batting = topBatters.rows.map((r, idx) => ({
        rank: idx + 1,
        name: r.name,
        team: formatCountry(r.nationality),
        rating: Number(r.batting_rating || r.overall_rating || Math.round(Number(r.runs) * 1.5 + Number(r.batting_avg || 0) * 8)),
        stat: `${r.runs} Runs (${r.total_hundreds}x100, ${r.total_fifties}x50, Avg: ${r.batting_avg || 0})`,
      }));

      const bowling = topBowlers.rows.map((r, idx) => ({
        rank: idx + 1,
        name: r.name,
        team: formatCountry(r.nationality),
        rating: Number(r.bowling_rating || r.overall_rating || Math.round(Number(r.wickets) * 45 - Number(r.economy || 0) * 10)),
        stat: `${r.wickets} Wkts (Econ: ${r.economy || 0}, ${formatCricketOvers(null, Number(r.balls_bowled))} ov)`,
      }));

      const mostRuns = topBatters.rows.map((r, idx) => ({
        rank: idx + 1,
        id: r.id,
        name: r.name,
        country: formatCountry(r.nationality),
        rating: Number(r.batting_rating || r.overall_rating || 0),
        matches: Number(r.matches) || 0,
        innings: Number(r.matches) || 0,
        runs: Number(r.runs) || 0,
        highestScore: Number(r.highest_score) || 0,
        battingAvg: r.batting_avg || "0.00",
        strikeRate: r.strike_rate || "0.0",
        hundreds: Number(r.total_hundreds) || 0,
        fifties: Number(r.total_fifties) || 0,
      }));

      const mostWickets = topBowlers.rows.map((r, idx) => {
        const bbiRuns = r.best_runs === 999 ? 0 : (r.best_runs || 0);
        const bbiStr = (r.best_wickets > 0 || bbiRuns > 0) ? `${r.best_wickets || 0}/${bbiRuns}` : "-";
        return {
          rank: idx + 1,
          id: r.id,
          name: r.name,
          country: formatCountry(r.nationality),
          rating: Number(r.bowling_rating || r.overall_rating || 0),
          matches: Number(r.matches) || 0,
          wickets: Number(r.wickets) || 0,
          overs: formatCricketOvers(null, Number(r.balls_bowled) || 0),
          runsConceded: Number(r.runs_conceded) || 0,
          economy: r.economy || "0.00",
          bowlingAvg: r.bowling_avg || "0.00",
          bestBowling: bbiStr,
        };
      });

      const highestScores = hsRes.rows.map((r, idx) => ({
        rank: idx + 1,
        id: r.id,
        name: r.name,
        country: formatCountry(r.nationality),
        rating: Number(r.batting_rating || r.overall_rating || 0),
        score: Number(r.score) || 0,
        runs: Number(r.runs) || 0,
        hundreds: Number(r.hundreds) || 0,
        fifties: Number(r.fifties) || 0,
        matches: Number(r.matches) || 0,
      }));

      const bestBowling = bbiRes.rows.map((r, idx) => {
        const bbiRuns = r.best_runs === 999 ? 0 : (r.best_runs || 0);
        const bbiStr = (r.best_wickets > 0 || bbiRuns > 0) ? `${r.best_wickets || 0}/${bbiRuns}` : "-";
        return {
          rank: idx + 1,
          id: r.id,
          name: r.name,
          country: formatCountry(r.nationality),
          rating: Number(r.bowling_rating || r.overall_rating || 0),
          bestBowling: bbiStr,
          wickets: Number(r.wickets) || 0,
          matches: Number(r.matches) || 0,
        };
      });

      return res.json({
        success: true,
        scope: "domestic",
        format,
        rankings: { batting, bowling, all_rounders: [], teams: [] },
        leaderboards: {
          orangeCap: mostRuns.slice(0, 5),
          purpleCap: mostWickets.slice(0, 5),
          mostRuns,
          mostWickets,
          highestScores,
          bestBowling,
        },
      });
    }

    // 3. Overall Universe Rankings & Leaderboards
    const [overallBatters, overallBowlers, overallAllRounders, hsRes, bbiRes] = await Promise.all([
      query(`
        SELECT id, name, nationality, overall_rating, batting_rating, archetype,
               (COALESCE(career_matches,0) + COALESCE(odi_matches,0) + COALESCE(test_matches,0)) as matches,
               (COALESCE(career_innings,0) + COALESCE(odi_innings,0) + COALESCE(test_innings,0)) as innings,
               (COALESCE(career_runs,0) + COALESCE(odi_runs,0) + COALESCE(test_runs,0)) as runs,
               GREATEST(COALESCE(career_highest_score,0), COALESCE(odi_highest_score,0), COALESCE(test_highest_score,0)) as highest_score,
               (COALESCE(career_hundreds,0) + COALESCE(odi_hundreds,0) + COALESCE(test_hundreds,0)) as hundreds,
               (COALESCE(career_fifties,0) + COALESCE(odi_fifties,0) + COALESCE(test_fifties,0)) as fifties,
               (COALESCE(career_balls_faced,0) + COALESCE(odi_balls_faced,0) + COALESCE(test_balls_faced,0)) as balls_faced,
               ROUND((COALESCE(career_runs,0) + COALESCE(odi_runs,0) + COALESCE(test_runs,0))::numeric / GREATEST(1, ((COALESCE(career_innings,0) - COALESCE(career_not_outs,0)) + (COALESCE(odi_innings,0) - COALESCE(odi_not_outs,0)) + (COALESCE(test_innings,0) - COALESCE(test_not_outs,0))))::numeric, 2) as batting_avg,
               ROUND(((COALESCE(career_runs,0) + COALESCE(odi_runs,0) + COALESCE(test_runs,0))::numeric / GREATEST(1, (COALESCE(career_balls_faced,0) + COALESCE(odi_balls_faced,0) + COALESCE(test_balls_faced,0)))::numeric) * 100, 1) as strike_rate
        FROM players
        ORDER BY runs DESC
        LIMIT 25
      `),
      query(`
        SELECT id, name, nationality, overall_rating, bowling_rating, archetype,
               (COALESCE(career_matches,0) + COALESCE(odi_matches,0) + COALESCE(test_matches,0)) as matches,
               (COALESCE(career_wickets,0) + COALESCE(odi_wickets,0) + COALESCE(test_wickets,0)) as wickets,
               (COALESCE(career_balls_bowled,0) + COALESCE(odi_balls_bowled,0) + COALESCE(test_balls_bowled,0)) as balls_bowled,
               (COALESCE(career_runs_conceded,0) + COALESCE(odi_runs_conceded,0) + COALESCE(test_runs_conceded,0)) as runs_conceded,
               GREATEST(COALESCE(career_best_figures_wickets,0), COALESCE(odi_best_figures_wickets,0), COALESCE(test_best_figures_wickets,0)) as best_wickets,
               LEAST(NULLIF(COALESCE(career_best_figures_runs,0),0), NULLIF(COALESCE(odi_best_figures_runs,0),0), NULLIF(COALESCE(test_best_figures_runs,0),0)) as best_runs,
               ROUND(((COALESCE(career_runs_conceded,0) + COALESCE(odi_runs_conceded,0) + COALESCE(test_runs_conceded,0))::numeric / GREATEST(1, (COALESCE(career_balls_bowled,0) + COALESCE(odi_balls_bowled,0) + COALESCE(test_balls_bowled,0)))::numeric) * 6, 2) as economy,
               ROUND((COALESCE(career_runs_conceded,0) + COALESCE(odi_runs_conceded,0) + COALESCE(test_runs_conceded,0))::numeric / GREATEST(1, (COALESCE(career_wickets,0) + COALESCE(odi_wickets,0) + COALESCE(test_wickets,0)))::numeric, 2) as bowling_avg
        FROM players
        ORDER BY wickets DESC
        LIMIT 25
      `),
      query(`
        SELECT id, name, nationality, overall_rating, batting_rating, bowling_rating, archetype,
               (COALESCE(career_runs,0) + COALESCE(odi_runs,0)) as total_runs,
               (COALESCE(career_wickets,0) + COALESCE(odi_wickets,0)) as total_wickets
        FROM players
        WHERE archetype IN ('batting_all_rounder', 'balanced_all_rounder', 'bowling_all_rounder')
        ORDER BY (batting_rating + bowling_rating) DESC
        LIMIT 25
      `),
      query(`
        SELECT id, name, nationality, overall_rating, batting_rating,
               GREATEST(COALESCE(career_highest_score,0), COALESCE(odi_highest_score,0), COALESCE(test_highest_score,0)) as score,
               (COALESCE(career_runs,0) + COALESCE(odi_runs,0) + COALESCE(test_runs,0)) as runs,
               (COALESCE(career_hundreds,0) + COALESCE(odi_hundreds,0) + COALESCE(test_hundreds,0)) as hundreds,
               (COALESCE(career_fifties,0) + COALESCE(odi_fifties,0) + COALESCE(test_fifties,0)) as fifties,
               (COALESCE(career_matches,0) + COALESCE(odi_matches,0) + COALESCE(test_matches,0)) as matches
        FROM players
        WHERE GREATEST(COALESCE(career_highest_score,0), COALESCE(odi_highest_score,0), COALESCE(test_highest_score,0)) > 0
        ORDER BY score DESC
        LIMIT 25
      `),
      query(`
        SELECT id, name, nationality, overall_rating, bowling_rating,
               GREATEST(COALESCE(career_best_figures_wickets,0), COALESCE(odi_best_figures_wickets,0), COALESCE(test_best_figures_wickets,0)) as best_wickets,
               LEAST(NULLIF(COALESCE(career_best_figures_runs,0),0), NULLIF(COALESCE(odi_best_figures_runs,0),0), NULLIF(COALESCE(test_best_figures_runs,0),0)) as best_runs,
               (COALESCE(career_wickets,0) + COALESCE(odi_wickets,0) + COALESCE(test_wickets,0)) as total_wickets,
               (COALESCE(career_matches,0) + COALESCE(odi_matches,0) + COALESCE(test_matches,0)) as matches
        FROM players
        WHERE GREATEST(COALESCE(career_best_figures_wickets,0), COALESCE(odi_best_figures_wickets,0), COALESCE(test_best_figures_wickets,0)) > 0
        ORDER BY best_wickets DESC, best_runs ASC
        LIMIT 25
      `),
    ]);

    const mostRuns = overallBatters.rows.map((r, idx) => ({
      rank: idx + 1,
      id: r.id,
      name: r.name,
      country: formatCountry(r.nationality),
      rating: Number(r.batting_rating || r.overall_rating || 0),
      matches: Number(r.matches) || 0,
      innings: Number(r.innings) || 0,
      runs: Number(r.runs) || 0,
      highestScore: Number(r.highest_score) || 0,
      battingAvg: r.batting_avg || "0.00",
      strikeRate: r.strike_rate || "0.0",
      hundreds: Number(r.hundreds) || 0,
      fifties: Number(r.fifties) || 0,
    }));

    const mostWickets = overallBowlers.rows.map((r, idx) => ({
      rank: idx + 1,
      id: r.id,
      name: r.name,
      country: formatCountry(r.nationality),
      rating: Number(r.bowling_rating || r.overall_rating || 0),
      matches: Number(r.matches) || 0,
      wickets: Number(r.wickets) || 0,
      overs: formatCricketOvers(null, Number(r.balls_bowled) || 0),
      runsConceded: Number(r.runs_conceded) || 0,
      economy: r.economy || "0.00",
      bowlingAvg: r.bowling_avg || "0.00",
      bestBowling: (r.best_wickets > 0 || r.best_runs > 0) ? `${r.best_wickets || 0}/${r.best_runs || 0}` : "-",
    }));

    const highestScores = hsRes.rows.map((r, idx) => ({
      rank: idx + 1,
      id: r.id,
      name: r.name,
      country: formatCountry(r.nationality),
      rating: Number(r.batting_rating || r.overall_rating || 0),
      score: Number(r.score) || 0,
      runs: Number(r.runs) || 0,
      hundreds: Number(r.hundreds) || 0,
      fifties: Number(r.fifties) || 0,
      matches: Number(r.matches) || 0,
    }));

    const bestBowling = bbiRes.rows.map((r, idx) => ({
      rank: idx + 1,
      id: r.id,
      name: r.name,
      country: formatCountry(r.nationality),
      rating: Number(r.bowling_rating || r.overall_rating || 0),
      bestBowling: (r.best_wickets > 0 || r.best_runs > 0) ? `${r.best_wickets || 0}/${r.best_runs || 0}` : "-",
      wickets: Number(r.total_wickets) || 0,
      matches: Number(r.matches) || 0,
    }));

    res.json({
      success: true,
      scope: "overall",
      rankings: {
        batting: [...overallBatters.rows].sort((a,b) => b.batting_rating - a.batting_rating).map((r, idx) => ({
          rank: idx + 1,
          name: r.name,
          team: formatCountry(r.nationality),
          rating: r.batting_rating,
          stat: `${Number(r.runs).toLocaleString()} Career Runs (${r.hundreds}x100)`,
        })),
        bowling: [...overallBowlers.rows].sort((a,b) => b.bowling_rating - a.bowling_rating).map((r, idx) => ({
          rank: idx + 1,
          name: r.name,
          team: formatCountry(r.nationality),
          rating: r.bowling_rating,
          stat: `${Number(r.wickets)} Career Wickets`,
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
      leaderboards: {
        orangeCap: mostRuns.slice(0, 5),
        purpleCap: mostWickets.slice(0, 5),
        mostRuns,
        mostWickets,
        highestScores,
        bestBowling,
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
      SELECT tm.tournament_id, count(DISTINCT m.id) as count
      FROM tournament_matches tm
      JOIN matches m ON m.id = tm.match_id
      WHERE m.status = 'completed'
      GROUP BY tm.tournament_id
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

    // Total completed tournament matches count (distinct match IDs)
    const countRes = await query(`
      SELECT count(DISTINCT m.id) as count
      FROM tournament_matches tm
      JOIN matches m ON m.id = tm.match_id
      WHERE UPPER(tm.tournament_id) = $1 AND m.status = 'completed'
    `, [tourneyId.toUpperCase()]);
    const totalCompletedMatches = Number(countRes.rows[0]?.count || 0);

    // Recent tournament matches (up to 30)
    const tourneyMatches = await query(`
      SELECT m.id, m.team_a_id, m.team_b_id, m.team_a_name, m.team_b_name,
             m.team_a_score, m.team_a_wickets, m.team_a_overs,
             m.team_b_score, m.team_b_wickets, m.team_b_overs,
             m.winner_team_id, m.winner_team_name, m.result_description, m.completed_at
      FROM matches m
      JOIN tournament_matches tm ON tm.match_id = m.id
      WHERE UPPER(tm.tournament_id) = $1 AND m.status = 'completed'
      ORDER BY m.id DESC
      LIMIT 30
    `, [tourneyId.toUpperCase()]);

    const tType = tourney ? tourney.type : "short";

    // Format-Aware Top Batters with dismissals & average
    const topBattersRes = await query(`
      SELECT tps.player_id, tps.player_name,
             CASE 
               WHEN $1 = 'test_match' THEN GREATEST(COALESCE(tps.test_matches, 0), COALESCE(tps.matches, 0))
               WHEN $1 = 'odi' THEN GREATEST(COALESCE(tps.odi_matches, 0), COALESCE(tps.matches, 0))
               ELSE GREATEST(COALESCE(tps.matches, 0), COALESCE(tps.odi_matches, 0), COALESCE(tps.test_matches, 0))
             END as matches,
             CASE 
               WHEN $1 = 'test_match' THEN GREATEST(COALESCE(tps.test_innings, 0), COALESCE(tps.innings, 0))
               WHEN $1 = 'odi' THEN GREATEST(COALESCE(tps.odi_innings, 0), COALESCE(tps.innings, 0))
               ELSE GREATEST(COALESCE(tps.innings, 0), COALESCE(tps.odi_innings, 0), COALESCE(tps.test_innings, 0))
             END as innings,
             CASE 
               WHEN $1 = 'test_match' THEN GREATEST(0, COALESCE(tps.test_innings, 0) - COALESCE(tps.test_not_outs, 0))
               WHEN $1 = 'odi' THEN GREATEST(0, COALESCE(tps.odi_innings, 0) - COALESCE(tps.odi_not_outs, 0))
               ELSE GREATEST(0, COALESCE(tps.dismissals, 0))
             END as dismissals,
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

    // Format-Aware Top Bowlers with average
    const topBowlersRes = await query(`
      SELECT tps.player_id, tps.player_name,
             CASE 
               WHEN $1 = 'test_match' THEN GREATEST(COALESCE(tps.test_matches, 0), COALESCE(tps.matches, 0))
               WHEN $1 = 'odi' THEN GREATEST(COALESCE(tps.odi_matches, 0), COALESCE(tps.matches, 0))
               ELSE GREATEST(COALESCE(tps.matches, 0), COALESCE(tps.odi_matches, 0), COALESCE(tps.test_matches, 0))
             END as matches,
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
      const dismissals = Number(b.dismissals) || 0;
      const avgStr = dismissals > 0 ? (runs / dismissals).toFixed(2) : (runs > 0 ? `${runs}.00*` : "-");
      return {
        rank: idx + 1,
        id: b.player_id,
        name: b.player_name,
        matches: Number(b.matches) || 0,
        runs,
        balls,
        average: avgStr,
        battingAvg: avgStr,
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
      const bowlAvgStr = wickets > 0 ? (runs / wickets).toFixed(2) : "-";
      return {
        rank: idx + 1,
        id: w.player_id,
        name: w.player_name,
        matches: Number(w.matches) || 0,
        wickets,
        overs: formatCricketOvers(null, balls),
        runs,
        average: bowlAvgStr,
        bowlingAvg: bowlAvgStr,
        economy: oversNum > 0 ? (runs / oversNum).toFixed(2) : "0.00",
      };
    });

    // Compute true tournament participating teams and win/loss records across all completed matches
    const allTourneyMatchesRes = await query(`
      SELECT DISTINCT ON (m.id) m.id, m.team_a_id, m.team_b_id, m.team_a_name, m.team_b_name,
             m.winner_team_id, m.winner_team_name, m.result_description
      FROM tournament_matches tm
      JOIN matches m ON m.id = tm.match_id
      WHERE UPPER(tm.tournament_id) = $1 AND m.status = 'completed'
      ORDER BY m.id ASC
    `, [tourneyId.toUpperCase()]);

    const isTestTourney = Boolean(tourney?.type === "test_match");
    const teamRecordMap = new Map();
    for (const m of allTourneyMatchesRes.rows) {
      if (!teamRecordMap.has(m.team_a_id)) {
        teamRecordMap.set(m.team_a_id, {
          id: m.team_a_id,
          name: m.team_a_name.replace(/\s+/g, " ").trim(),
          played: 0, won: 0, lost: 0, tied: 0, draws: 0, noResult: 0, points: 0,
        });
      }
      if (!teamRecordMap.has(m.team_b_id)) {
        teamRecordMap.set(m.team_b_id, {
          id: m.team_b_id,
          name: m.team_b_name.replace(/\s+/g, " ").trim(),
          played: 0, won: 0, lost: 0, tied: 0, draws: 0, noResult: 0, points: 0,
        });
      }
      const tA = teamRecordMap.get(m.team_a_id);
      const tB = teamRecordMap.get(m.team_b_id);
      tA.played++;
      tB.played++;

      const isTie = /tie/i.test(m.result_description || "") || /tied/i.test(m.winner_team_name || "");
      const isDraw = /draw/i.test(m.result_description || "") || /draw/i.test(m.winner_team_name || "");
      const isNoResult = /no result|abandon/i.test(m.result_description || "");

      if (isNoResult) {
        tA.noResult++; tA.points += 1;
        tB.noResult++; tB.points += 1;
      } else if (isTie) {
        tA.tied++; tA.points += 1;
        tB.tied++; tB.points += 1;
      } else if (isDraw && isTestTourney) {
        tA.draws++; tA.points += 4;
        tB.draws++; tB.points += 4;
      } else if (m.winner_team_id === m.team_a_id || (m.winner_team_name && m.winner_team_name.toLowerCase().trim() === m.team_a_name.toLowerCase().trim())) {
        tA.won++; tA.points += (isTestTourney ? 12 : 2);
        tB.lost++;
      } else if (m.winner_team_id === m.team_b_id || (m.winner_team_name && m.winner_team_name.toLowerCase().trim() === m.team_b_name.toLowerCase().trim())) {
        tB.won++; tB.points += (isTestTourney ? 12 : 2);
        tA.lost++;
      }
    }

    const participatingTeams = Array.from(teamRecordMap.values())
      .map(t => ({
        ...t,
        teamName: t.name,
        shortName: t.name.slice(0, 4).toUpperCase(),
        winPct: t.played > 0 ? Math.round((t.won / t.played) * 100) : 0,
      }))
      .sort((a, b) => b.won - a.won || b.winPct - a.winPct || b.played - a.played);

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
      matchesCount: totalCompletedMatches,
      isTest: isTestTourney,
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
      participatingTeams,
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
let cachedOverview = null;
let lastOverviewFetch = 0;

app.get("/api/overview", async (req, res) => {
  const now = Date.now();
  if (cachedOverview && now - lastOverviewFetch < 30000) {
    return res.json(cachedOverview);
  }

  try {
    const countsRes = await query(`
      SELECT
        (SELECT count(*) FROM matches) as total_matches,
        (SELECT count(*) FROM players) as total_players,
        (SELECT count(*) FROM teams) as total_teams,
        (SELECT count(*) FROM tournaments) as total_tournaments
    `);
    const r = countsRes.rows[0] || {};
    let liveCount = 0;
    try {
      const liveRes = await query("SELECT count(*) as count FROM active_match_states");
      liveCount = Number(liveRes.rows[0]?.count || 0);
    } catch {}

    cachedOverview = {
      success: true,
      liveMatchCount: liveCount,
      totalPlayers: Number(r.total_players || 0),
      totalMatches: Number(r.total_matches || 0),
      totalTeams: Number(r.total_teams || 0),
      totalTournaments: Number(r.total_tournaments || 0),
    };
    lastOverviewFetch = now;
    res.json(cachedOverview);
  } catch (err) {
    console.error("Error in /api/overview:", err);
    if (cachedOverview) return res.json(cachedOverview);
    res.status(500).json({ success: false, error: err.message || "Failed to load overview" });
  }
});

// -----------------------------------------------------------------------------
// Static Files & Client-Side Routing
// -----------------------------------------------------------------------------
app.use(express.static(path.join(__dirname, "public")));
app.use(express.static(__dirname));

app.get("*", (req, res) => {
  const publicIndex = path.join(__dirname, "public", "index.html");
  if (fs.existsSync(publicIndex)) {
    return res.sendFile(publicIndex);
  }
  res.sendFile(path.join(__dirname, "index.html"));
});

// -----------------------------------------------------------------------------
// Start Server (Only when not executed inside Vercel serverless environment)
// -----------------------------------------------------------------------------
if (!process.env.VERCEL) {
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
}

export default app;
