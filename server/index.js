/* global process */

import { get as getBlob, put as putBlob } from "@vercel/blob";
import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import OpenAI from "openai";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const storageDir = path.join(__dirname, "data");
const storagePath = path.join(storageDir, "app-state.json");
const distDir = path.join(rootDir, "dist");
const port = Number(process.env.PORT || 3001);
const OPENAI_MODEL = "gpt-5.4";
const FORTY_EIGHT_HOURS_MS = 48 * 60 * 60 * 1000;
const BLOB_STATE_PATHNAME = process.env.VERCEL_BLOB_STATE_PATH || "state/app-state.json";

const defaultState = {
  bankroll: {
    sleeper: 25,
    prizepicks: 25,
    startingSleeper: 25,
    startingPrizePicks: 25,
    entryPct: 10,
    maxEntryPct: 20,
  },
  record: {
    sleeperWins: 0,
    sleeperLosses: 0,
    prizePicksWins: 0,
    prizePicksLosses: 0,
    consecutiveLosses: 0,
    lastLossAt: "",
  },
  entries: [],
  props: [],
  journal: [],
  settings: {
    openaiApiKey: "",
    ballDontLieApiKey: "",
    oddsApiKey: "",
    oddsProvider: "manual",
    aiAnalysisEnabled: false,
    autoLoadSlate: false,
    preferredDate: new Date().toISOString().slice(0, 10),
    notes: "",
  },
};

const statMap = {
  points: { label: "Points", propType: "points", statKey: "pts", oddsApiMarket: "player_points" },
  rebounds: { label: "Rebounds", propType: "rebounds", statKey: "reb", oddsApiMarket: "player_rebounds" },
  assists: { label: "Assists", propType: "assists", statKey: "ast", oddsApiMarket: "player_assists" },
  "3-pointers made": { label: "3-Pointers", propType: "threes", statKey: "3pm", oddsApiMarket: "player_threes" },
  steals: { label: "Steals", propType: "steals", statKey: "stl", oddsApiMarket: "player_steals" },
  blocks: { label: "Blocks", propType: "blocks", statKey: "blk", oddsApiMarket: "player_blocks" },
  pra: { label: "PRA", propType: "points_rebounds_assists", statKey: "pra", oddsApiMarket: "player_points_rebounds_assists" },
};

const sharpVendors = ["draftkings", "fanduel", "caesars"];

const clampPercent = (value, fallback) => {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(20, Math.max(1, parsed));
};

const round = (value, decimals = 2) => Number(value.toFixed(decimals));

const toNumberOrNull = (value) => {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const addDays = (dateString, offset) => {
  const date = new Date(`${dateString}T00:00:00`);
  date.setDate(date.getDate() + offset);
  return date.toISOString().slice(0, 10);
};

const slugify = (value = "") => value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");

const getPropId = (prop) => [prop.date, prop.player, prop.stat].map(slugify).join("__");

const getResearchConfidence = ({
  providerUsed,
  sharpConsensus,
  manualRecentAverage,
  manualSampleSize,
  notesCount,
  aiSummary,
  manualMinutes,
  hasManualContextEdge,
  lineQuality,
}) => {
  if (providerUsed && sharpConsensus != null && manualRecentAverage != null && manualSampleSize >= 3) return "high";

  if (
    sharpConsensus == null &&
    lineQuality === "FALLBACK" &&
    manualRecentAverage != null &&
    manualSampleSize >= 5 &&
    manualMinutes != null &&
    manualMinutes >= 28 &&
    (notesCount >= 2 || aiSummary || hasManualContextEdge)
  ) {
    return "high";
  }

  if (
    sharpConsensus == null &&
    manualRecentAverage != null &&
    manualSampleSize >= 3 &&
    (notesCount >= 1 || aiSummary || hasManualContextEdge)
  ) {
    return "medium";
  }

  if ((sharpConsensus != null || providerUsed) && (manualRecentAverage != null || aiSummary || notesCount > 0)) return "medium";
  return "low";
};

const getQueueBucket = ({ finalVerdict, lineQuality, hasManualContextEdge, sleeperLine, prizePicksLine }) => {
  if (!sleeperLine && !prizePicksLine) return "need-line";
  if (finalVerdict === "SKIP") return "skip";
  if (lineQuality === "SOFT" && hasManualContextEdge) return "playable";
  return "watch";
};

const getBestPlayScore = ({ lineQuality, hasManualContextEdge, finalVerdict, sharpConsensus, researchConfidence }) => {
  let score = 0;
  if (lineQuality === "SOFT") score += 3;
  if (lineQuality === "NEUTRAL") score += 1;
  if (hasManualContextEdge) score += 2;
  if (finalVerdict === "MORE" || finalVerdict === "LESS") score += 2;
  if (sharpConsensus != null) score += 1;
  if (researchConfidence === "high") score += 2;
  if (researchConfidence === "medium") score += 1;
  return score;
};

const getRecommendedEntry = (bankroll, entryPct, maxEntryPct) => {
  if (bankroll <= 0) return 0;
  const pct = Math.min(entryPct, maxEntryPct);
  const percentStake = bankroll * (pct / 100);
  const microCap = bankroll < 10 ? 1 : Number.POSITIVE_INFINITY;
  return round(Math.min(percentStake, microCap));
};

const getMaxEntry = (bankroll, maxEntryPct) => {
  if (bankroll <= 0) return 0;
  return round(bankroll * (maxEntryPct / 100));
};

const getRestriction = (state) => {
  const { lastLossAt, consecutiveLosses } = state.record;
  if (!lastLossAt || consecutiveLosses <= 0) {
    return { level: "clear", hardBlock: false, message: "" };
  }

  const lossAt = new Date(lastLossAt);
  if (Number.isNaN(lossAt.getTime())) {
    return { level: "clear", hardBlock: false, message: "" };
  }

  const now = new Date();
  const sameDay = now.toDateString() === lossAt.toDateString();
  const within48Hours = now.getTime() - lossAt.getTime() < FORTY_EIGHT_HOURS_MS;

  if (consecutiveLosses >= 3 && within48Hours) {
    return {
      level: "break",
      hardBlock: true,
      message: "Three straight losses logged. Lock entries for 48 hours and do not chase.",
    };
  }

  if (consecutiveLosses >= 2 && sameDay) {
    return {
      level: "stop",
      hardBlock: true,
      message: "Two straight losses today. Stop for the day and do not force another entry.",
    };
  }

  if (consecutiveLosses >= 1 && sameDay) {
    return {
      level: "cooloff",
      hardBlock: true,
      message: "One loss logged today. Wait for the next slate before placing another entry.",
    };
  }

  return { level: "clear", hardBlock: false, message: "" };
};

const ensureStorage = () => {
  if (!fs.existsSync(storageDir)) {
    fs.mkdirSync(storageDir, { recursive: true });
  }

  if (!fs.existsSync(storagePath)) {
    fs.writeFileSync(storagePath, JSON.stringify(defaultState, null, 2));
  }
};

const shouldUseBlobStorage = () => Boolean(process.env.BLOB_READ_WRITE_TOKEN);

const deepMerge = (base, incoming) => {
  if (Array.isArray(base) || Array.isArray(incoming)) {
    return incoming ?? base;
  }

  if (typeof base !== "object" || typeof incoming !== "object" || !base || !incoming) {
    return incoming ?? base;
  }

  return Object.fromEntries(
    Object.keys({ ...base, ...incoming }).map((key) => [
      key,
      key in incoming ? deepMerge(base[key], incoming[key]) : base[key],
    ]),
  );
};

const readState = async () => {
  if (shouldUseBlobStorage()) {
    try {
      const blob = await getBlob(BLOB_STATE_PATHNAME, { access: "private" });
      const raw = await new Response(blob.stream).text();
      return deepMerge(defaultState, JSON.parse(raw));
    } catch {
      return structuredClone(defaultState);
    }
  }

  ensureStorage();
  try {
    const raw = fs.readFileSync(storagePath, "utf8");
    return deepMerge(defaultState, JSON.parse(raw));
  } catch {
    return structuredClone(defaultState);
  }
};

const writeState = async (nextState) => {
  if (shouldUseBlobStorage()) {
    await putBlob(BLOB_STATE_PATHNAME, JSON.stringify(nextState, null, 2), {
      access: "private",
      allowOverwrite: true,
      contentType: "application/json",
    });
    return nextState;
  }

  ensureStorage();
  fs.writeFileSync(storagePath, JSON.stringify(nextState, null, 2));
  return nextState;
};

let stateWriteQueue = Promise.resolve();

const updateState = async (updater) => {
  let result;
  stateWriteQueue = stateWriteQueue.then(async () => {
    const current = await readState();
    const next = await updater(structuredClone(current));
    result = await writeState(next);
    return result;
  });
  await stateWriteQueue;
  return result;
};

const getApiKeys = (state) => ({
  openai: state.settings.openaiApiKey || process.env.OPENAI_API_KEY || "",
  ballDontLie: state.settings.ballDontLieApiKey || process.env.BALLDONTLIE_API_KEY || "",
  odds: state.settings.oddsApiKey || process.env.ODDS_API_KEY || "",
});

const getSummaryMetrics = (state) => {
  const total = state.bankroll.sleeper + state.bankroll.prizepicks;
  const sleeperStdEntry = getRecommendedEntry(
    state.bankroll.sleeper,
    state.bankroll.entryPct,
    state.bankroll.maxEntryPct,
  );
  const prizePicksStdEntry = getRecommendedEntry(
    state.bankroll.prizepicks,
    state.bankroll.entryPct,
    state.bankroll.maxEntryPct,
  );

  return {
    totalBankroll: round(total),
    sleeperStdEntry,
    prizePicksStdEntry,
    sleeperMaxEntry: getMaxEntry(state.bankroll.sleeper, state.bankroll.maxEntryPct),
    prizePicksMaxEntry: getMaxEntry(state.bankroll.prizepicks, state.bankroll.maxEntryPct),
    restriction: getRestriction(state),
    savedProps: state.props.length,
    playableProps: state.props.filter((prop) => prop.bucket === "playable").length,
  };
};

const appSnapshot = (state) => {
  const metrics = getSummaryMetrics(state);
  const topProps = [...state.props]
    .sort((a, b) => (b.bestPlayScore ?? 0) - (a.bestPlayScore ?? 0))
    .slice(0, 8);

  return {
    ...state,
    metrics,
    topProps,
    capabilities: {
      openaiConfigured: Boolean(getApiKeys(state).openai),
      ballDontLieConfigured: Boolean(getApiKeys(state).ballDontLie),
      oddsProviderConfigured: state.settings.oddsProvider !== "manual" && Boolean(getApiKeys(state).odds),
      oddsProvider: state.settings.oddsProvider,
      aiEnabled: Boolean(getApiKeys(state).openai) && state.settings.aiAnalysisEnabled,
    },
  };
};

const parseOpenAIText = (response) => {
  if (typeof response.output_text === "string" && response.output_text.trim()) {
    return response.output_text.trim();
  }

  const blocks = Array.isArray(response.output)
    ? response.output
        .filter((item) => item.type === "message")
        .flatMap((item) => (Array.isArray(item.content) ? item.content : []))
        .filter((item) => item.type === "output_text")
        .map((item) => item.text)
    : [];

  return blocks.join("\n").trim();
};

const parseJsonFromText = (text) => {
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {
    const objectMatch = text.match(/\{[\s\S]*\}/);
    if (!objectMatch) return null;

    try {
      return JSON.parse(objectMatch[0]);
    } catch {
      return null;
    }
  }
};

const createOpenAIClient = (state) => {
  const apiKey = getApiKeys(state).openai;
  if (!apiKey) {
    throw new Error("Add an OpenAI API key in Settings or your server environment first.");
  }
  return new OpenAI({ apiKey });
};

const buildSearchPrompt = ({ player, stat, context, lineSummary, injuries, recentGames, bankroll }) => `
You are helping Ant evaluate one NBA prop. Follow this order exactly:
1. LINE VALUE CHECK FIRST
2. PLAYER ANALYSIS SECOND
3. BANKROLL SIZING THIRD

Return concise plain text with headings:
LINE VALUE CHECK
PLAYER ANALYSIS
BANKROLL SIZING
FINAL VERDICT

Player: ${player}
Stat: ${stat}
Line summary: ${JSON.stringify(lineSummary)}
User context: ${context || "None"}
Recent games: ${JSON.stringify(recentGames)}
Injuries: ${JSON.stringify(injuries)}
Bankroll context: ${JSON.stringify(bankroll)}

Rules:
- Standard size is 10% per platform.
- Never recommend above 20% on one entry.
- If the line is sharp and player context is not strong, say SKIP.
- If chasing safeguards should apply, say SKIP.
- End with one single-line verdict.
`;

const buildPlayerResearchPrompt = ({ player, stat, date, sleeperLine, prizePicksLine, sharpConsensus }) => `
You are researching one NBA player prop and must return ONLY valid raw JSON.

Player: ${player}
Stat: ${stat}
Date: ${date}
Sleeper line: ${sleeperLine || "Not provided"}
PrizePicks line: ${prizePicksLine || "Not provided"}
Sharp consensus line: ${sharpConsensus || "Not provided"}

Use web search to find timely information that helps with:
- recent production
- recent game log
- expected minutes
- usage or role change
- injury / roster impact
- matchup quality
- pace / game environment
- short role summary

Return ONLY this JSON shape:
{
  "recentAverage": number | null,
  "sampleSize": number | null,
  "recentGameLog": "string",
  "expectedMinutes": number | null,
  "usageChangePct": number | null,
  "matchupGrade": "favorable" | "neutral" | "tough",
  "injuryBoost": "string",
  "paceNote": "string",
  "roleNote": "string",
  "sourceNotes": "short string with source summary"
}

Rules:
- Be conservative. Use null if you cannot support a number.
- Keep strings concise.
- If recent average is based on the last 5 games, sampleSize should usually be 5.
- Output ONLY raw JSON. No markdown.
`;

const buildGameRosterPrompt = ({ date, matchup, homeTeam, awayTeam }) => `
You are building an NBA game card for a props workflow and must return ONLY valid raw JSON.

Date: ${date}
Matchup: ${matchup}
Home team: ${homeTeam}
Away team: ${awayTeam}

Use web search to identify the most likely starters and the key bench rotation players for this game.

Return ONLY this JSON shape:
{
  "gameSummary": "short string",
  "homeTeam": {
    "name": "string",
    "starters": ["Player 1", "Player 2", "Player 3", "Player 4", "Player 5"],
    "bench": ["Player 6", "Player 7", "Player 8", "Player 9", "Player 10"]
  },
  "awayTeam": {
    "name": "string",
    "starters": ["Player 1", "Player 2", "Player 3", "Player 4", "Player 5"],
    "bench": ["Player 6", "Player 7", "Player 8", "Player 9", "Player 10"]
  },
  "sourceNotes": "short string"
}

Rules:
- Favor currently expected starters and likely active rotation pieces for this date.
- Bench lists do not need to be exhaustive; include the main playable bench names.
- Output ONLY raw JSON. No markdown.
`;

const bdlFetch = async (state, endpoint, query = {}) => {
  const apiKey = getApiKeys(state).ballDontLie;
  if (!apiKey) {
    throw new Error("Add a BallDontLie API key to use live games, injuries, and sharp prop data.");
  }

  const url = new URL(`https://api.balldontlie.io${endpoint}`);
  Object.entries(query).forEach(([key, value]) => {
    if (Array.isArray(value)) {
      value.forEach((item) => url.searchParams.append(`${key}[]`, item));
      return;
    }

    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, value);
    }
  });

  const response = await fetch(url, {
    headers: {
      Authorization: apiKey,
    },
  });

  const raw = await response.text();
  let data = null;

  if (raw) {
    try {
      data = JSON.parse(raw);
    } catch {
      data = null;
    }
  }

  if (!response.ok) {
    const apiMessage =
      data?.error ||
      data?.message ||
      raw?.trim() ||
      "BallDontLie request failed.";
    const normalizedMessage = response.status === 429
      ? `BallDontLie rate limit hit: ${apiMessage}`
      : apiMessage;
    throw new Error(normalizedMessage);
  }

  return data ?? {};
};

const isAuthOrTierError = (error) => {
  const message = `${error?.message || ""}`.toLowerCase();
  return message.includes("unauthorized") || message.includes("forbidden") || message.includes("tier");
};

const oddsApiFetch = async (state, pathname, query = {}) => {
  const apiKey = getApiKeys(state).odds;
  if (!apiKey) {
    throw new Error("Add an Odds API key in Settings before using provider auto-fill.");
  }

  const url = new URL(`https://api.the-odds-api.com${pathname}`);
  url.searchParams.set("apiKey", apiKey);

  Object.entries(query).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, value);
    }
  });

  const response = await fetch(url);
  const raw = await response.text();
  let data = null;

  if (raw) {
    try {
      data = JSON.parse(raw);
    } catch {
      data = null;
    }
  }

  if (!response.ok) {
    throw new Error(data?.message || data?.error_code || raw?.trim() || "The Odds API request failed.");
  }

  return data ?? [];
};

const normalizePlayerName = (value = "") => value.toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();

const isSameCalendarDate = (isoTime, targetDate) => {
  if (!isoTime || !targetDate) return false;
  return new Date(isoTime).toISOString().slice(0, 10) === targetDate;
};

const getProviderBookPriority = (bookKey) => {
  const order = {
    prizepicks: 0,
    draftkings: 1,
    fanduel: 2,
    caesars: 3,
    betmgm: 4,
  };
  return order[bookKey] ?? 99;
};

const extractPropOutcomes = (eventOdds, playerName, marketKey) => {
  const normalizedTarget = normalizePlayerName(playerName);
  const rows = [];

  (eventOdds.bookmakers || []).forEach((bookmaker) => {
    (bookmaker.markets || [])
      .filter((market) => market.key === marketKey)
      .forEach((market) => {
        (market.outcomes || []).forEach((outcome) => {
          if (normalizePlayerName(outcome.description) === normalizedTarget) {
            rows.push({
              bookmaker: bookmaker.key,
              bookmakerTitle: bookmaker.title,
              market: market.key,
              side: outcome.name,
              line: Number.parseFloat(outcome.point),
              price: outcome.price,
            });
          }
        });
      });
  });

  return rows.filter((row) => Number.isFinite(row.line));
};

const buildProviderAutofill = async (state, payload) => {
  const provider = state.settings.oddsProvider;
  if (provider !== "the-odds-api") {
    throw new Error("Select The Odds API as your odds provider in Settings before using auto-fill.");
  }

  const statConfig = statMap[payload.stat] || statMap.points;
  const events = await oddsApiFetch(state, "/v4/sports/basketball_nba/events", {
    dateFormat: "iso",
  });

  const targetEvents = events.filter((event) => isSameCalendarDate(event.commence_time, payload.date)).slice(0, 12);
  if (!targetEvents.length) {
    throw new Error(`No NBA events returned for ${payload.date}.`);
  }

  const bookmakerKeys = "prizepicks,draftkings,fanduel,caesars";
  let matchedEvent = null;
  let propRows = [];

  for (const event of targetEvents) {
    const eventOdds = await oddsApiFetch(state, `/v4/sports/basketball_nba/events/${event.id}/odds`, {
      regions: "us,us_dfs",
      markets: statConfig.oddsApiMarket,
      bookmakers: bookmakerKeys,
      oddsFormat: "american",
    });

    const rows = extractPropOutcomes(eventOdds, payload.player, statConfig.oddsApiMarket);
    if (rows.length) {
      matchedEvent = eventOdds;
      propRows = rows;
      break;
    }
  }

  if (!matchedEvent || !propRows.length) {
    throw new Error(`No provider lines found for ${payload.player} ${statConfig.label} on ${payload.date}.`);
  }

  const prizePicksRow = [...propRows]
    .filter((row) => row.bookmaker === "prizepicks")
    .sort((a, b) => getProviderBookPriority(a.bookmaker) - getProviderBookPriority(b.bookmaker))[0];

  const sharpRows = propRows.filter((row) => ["draftkings", "fanduel", "caesars"].includes(row.bookmaker));
  const uniqueSharpLines = [...new Set(sharpRows.map((row) => row.line))];
  const sharpConsensus = uniqueSharpLines.length
    ? round(uniqueSharpLines.reduce((sum, value) => sum + value, 0) / uniqueSharpLines.length, 1)
    : null;

  return {
    provider,
    player: payload.player,
    stat: payload.stat,
    event: {
      id: matchedEvent.id,
      matchup: `${matchedEvent.away_team} @ ${matchedEvent.home_team}`,
      commenceTime: matchedEvent.commence_time,
    },
    suggestedPrizePicksLine: prizePicksRow?.line ?? null,
    suggestedSharpConsensus: sharpConsensus,
    sourceNotes: [
      prizePicksRow ? `PrizePicks line pulled from provider: ${prizePicksRow.line}` : "No PrizePicks line found from provider.",
      sharpRows.length
        ? `Sharp consensus built from ${[...new Set(sharpRows.map((row) => row.bookmakerTitle))].join(", ")}.`
        : "No sportsbook sharp rows found from provider.",
    ],
    rawSources: propRows
      .sort((a, b) => getProviderBookPriority(a.bookmaker) - getProviderBookPriority(b.bookmaker))
      .map((row) => ({
        bookmaker: row.bookmakerTitle,
        side: row.side,
        line: row.line,
        price: row.price,
      })),
  };
};

const buildAiPlayerResearch = async (state, payload) => {
  const client = createOpenAIClient(state);
  const response = await client.responses.create({
    model: OPENAI_MODEL,
    tools: [{ type: "web_search" }],
    tool_choice: "auto",
    input: buildPlayerResearchPrompt(payload),
  });

  const text = parseOpenAIText(response);
  const parsed = parseJsonFromText(text);

  if (!parsed || typeof parsed !== "object") {
    throw new Error("AI research did not return valid structured JSON.");
  }

  return {
    recentAverage: toNumberOrNull(parsed.recentAverage),
    sampleSize: toNumberOrNull(parsed.sampleSize),
    recentGameLog: parsed.recentGameLog || "",
    expectedMinutes: toNumberOrNull(parsed.expectedMinutes),
    usageChangePct: toNumberOrNull(parsed.usageChangePct),
    matchupGrade: ["favorable", "neutral", "tough"].includes(parsed.matchupGrade) ? parsed.matchupGrade : "neutral",
    injuryBoost: parsed.injuryBoost || "",
    paceNote: parsed.paceNote || "",
    roleNote: parsed.roleNote || "",
    sourceNotes: parsed.sourceNotes || "",
  };
};

const buildAiGameRoster = async (state, payload) => {
  let fallbackGame = null;

  try {
    const gamesResponse = await bdlFetch(state, "/v1/games", {
      dates: [payload.date],
      per_page: 100,
    });
    const games = gamesResponse.data || [];
    const game = games.find((item) => {
      const homeAbbr = item.home_team?.abbreviation;
      const awayAbbr = item.visitor_team?.abbreviation;
      return homeAbbr === payload.homeTeam && awayAbbr === payload.awayTeam;
    });
    fallbackGame = game || null;

    if (game?.id) {
      const lineupResponse = await bdlFetch(state, "/v1/lineups", {
        game_ids: [game.id],
        per_page: 100,
      });
      const lineupRows = lineupResponse.data || [];

      const buildTeamGroup = (teamId, fallbackName) => {
        const teamRows = lineupRows.filter((row) => row.team?.id === teamId || row.team_id === teamId);
        const starters = teamRows
          .filter((row) => row.starter)
          .map((row) => `${row.player?.first_name || ""} ${row.player?.last_name || ""}`.trim())
          .filter(Boolean);
        const bench = teamRows
          .filter((row) => !row.starter)
          .map((row) => `${row.player?.first_name || ""} ${row.player?.last_name || ""}`.trim())
          .filter(Boolean);

        return {
          name: teamRows[0]?.team?.full_name || fallbackName,
          starters: starters.slice(0, 5),
          bench: bench.slice(0, 10),
        };
      };

      const homeGroup = buildTeamGroup(game.home_team?.id, game.home_team?.full_name || payload.homeTeam);
      const awayGroup = buildTeamGroup(game.visitor_team?.id, game.visitor_team?.full_name || payload.awayTeam);

      if (homeGroup.starters.length || awayGroup.starters.length || homeGroup.bench.length || awayGroup.bench.length) {
        return {
          gameSummary: `Live lineup data loaded for ${payload.matchup}.`,
          homeTeam: homeGroup,
          awayTeam: awayGroup,
          sourceNotes: "Roster card built from BallDontLie lineups for this game.",
        };
      }
    }
  } catch {
    // Continue to additional fallback paths below.
  }

  if (fallbackGame?.home_team?.id && fallbackGame?.visitor_team?.id) {
    try {
      const [homePlayersResponse, awayPlayersResponse] = await Promise.all([
        bdlFetch(state, "/v1/players/active", {
          team_ids: [fallbackGame.home_team.id],
          per_page: 30,
        }),
        bdlFetch(state, "/v1/players/active", {
          team_ids: [fallbackGame.visitor_team.id],
          per_page: 30,
        }),
      ]);

      const toNames = (response) => (response.data || [])
        .map((player) => `${player.first_name || ""} ${player.last_name || ""}`.trim())
        .filter(Boolean);

      const homeNames = [...new Set(toNames(homePlayersResponse))];
      const awayNames = [...new Set(toNames(awayPlayersResponse))];

      if (homeNames.length || awayNames.length) {
        return {
          gameSummary: `Active roster fallback loaded for ${payload.matchup}. Confirm starters manually before using the player browser.`,
          homeTeam: {
            name: fallbackGame.home_team.full_name || payload.homeTeam,
            starters: homeNames.slice(0, 5),
            bench: homeNames.slice(5, 15),
          },
          awayTeam: {
            name: fallbackGame.visitor_team.full_name || payload.awayTeam,
            starters: awayNames.slice(0, 5),
            bench: awayNames.slice(5, 15),
          },
          sourceNotes: "BallDontLie lineups were unavailable, so this card falls back to active team rosters.",
        };
      }
    } catch {
      // Fall through to AI as a final fallback.
    }
  }

  const client = createOpenAIClient(state);
  const response = await client.responses.create({
    model: OPENAI_MODEL,
    tools: [{ type: "web_search" }],
    tool_choice: "auto",
    input: buildGameRosterPrompt(payload),
  });

  const text = parseOpenAIText(response);
  const parsed = parseJsonFromText(text);

  if (!parsed?.homeTeam || !parsed?.awayTeam) {
    throw new Error("AI roster research did not return a valid game roster payload.");
  }

  const normalizeGroup = (group) => ({
    name: group?.name || "",
    starters: Array.isArray(group?.starters) ? group.starters.filter(Boolean).slice(0, 5) : [],
    bench: Array.isArray(group?.bench) ? group.bench.filter(Boolean).slice(0, 10) : [],
  });

  return {
    gameSummary: parsed.gameSummary || "",
    homeTeam: normalizeGroup(parsed.homeTeam),
    awayTeam: normalizeGroup(parsed.awayTeam),
    sourceNotes: parsed.sourceNotes || "",
  };
};

const getLineValueSummary = ({ sleeperLine, prizePicksLine, sharpConsensus }) => {
  const sleeper = Number.parseFloat(sleeperLine);
  const prizePicks = Number.parseFloat(prizePicksLine);
  const sharp = Number.parseFloat(sharpConsensus);
  const hasSleeper = Number.isFinite(sleeper);
  const hasPrizePicks = Number.isFinite(prizePicks);

  if (!Number.isFinite(sharp)) {
    if (hasSleeper && hasPrizePicks) {
      const gap = round(sleeper - prizePicks, 1);
      if (Math.abs(gap) >= 0.5) {
        const lowerApp = sleeper < prizePicks ? "Sleeper" : "PrizePicks";
        const higherApp = sleeper < prizePicks ? "PrizePicks" : "Sleeper";
        const verdict = gap < 0 ? "MORE" : "LESS";
        return {
          gap,
          verdict,
          lineQuality: "FALLBACK",
          bestApp: lowerApp,
          leanText:
            verdict === "MORE"
              ? `${lowerApp} is ${Math.abs(gap).toFixed(1)} lower than ${higherApp}, so MORE has the provisional line-value edge even without a sharp consensus line.`
              : `${lowerApp} is ${Math.abs(gap).toFixed(1)} lower than ${higherApp}, so LESS is the safer angle only if you trust ${higherApp}'s higher number more.`,
        };
      }
    }

    return {
      gap: null,
      verdict: "ANALYZE",
      lineQuality: "UNKNOWN",
      bestApp: hasSleeper ? "Sleeper" : hasPrizePicks ? "PrizePicks" : "Manual",
      leanText: "Sharp market consensus is missing, so this stays in manual review unless both platform lines create a clear gap.",
    };
  }

  const preferredLine = hasSleeper
    ? sleeper
    : hasPrizePicks
      ? prizePicks
      : Number.NaN;

  if (!Number.isFinite(preferredLine)) {
    return {
      gap: null,
      verdict: "ANALYZE",
      lineQuality: "UNKNOWN",
      bestApp: "Manual",
      leanText: "Add at least one platform line before deciding.",
    };
  }

  const gap = round(preferredLine - sharp, 1);
  const usingSleeper = hasSleeper;

  if (gap <= -1.5) {
    return {
      gap,
      verdict: "MORE",
      lineQuality: "SOFT",
      bestApp: usingSleeper ? "Sleeper" : "PrizePicks",
      leanText: `${usingSleeper ? "Sleeper" : "PrizePicks"} is ${Math.abs(gap).toFixed(1)} below sharp, so MORE has the line-value edge.`,
    };
  }

  if (gap >= 1.5) {
    return {
      gap,
      verdict: "LESS",
      lineQuality: "SOFT",
      bestApp: usingSleeper ? "Sleeper" : "PrizePicks",
      leanText: `${usingSleeper ? "Sleeper" : "PrizePicks"} is ${gap.toFixed(1)} above sharp, so LESS has the line-value edge.`,
    };
  }

  if (Math.abs(gap) <= 0.5) {
    return {
      gap,
      verdict: "ANALYZE",
      lineQuality: "SHARP",
      bestApp: usingSleeper ? "Sleeper" : "PrizePicks",
      leanText: "Your platform line is hugging sharp, so any bet needs a strong player-context edge.",
    };
  }

  return {
    gap,
    verdict: "ANALYZE",
    lineQuality: "NEUTRAL",
    bestApp: usingSleeper ? "Sleeper" : "PrizePicks",
    leanText: "There is some movement versus sharp, but not enough to force an automatic entry.",
  };
};

const summarizeRecentGames = (stats, statKey) => {
  const values = stats.map((game) => Number(game?.[statKey] || 0));
  const average = values.length ? round(values.reduce((sum, value) => sum + value, 0) / values.length, 1) : 0;
  const lastFive = values.join(", ");

  return {
    average,
    sample: values.length,
    lastFive,
  };
};

const normalizePlayerSearch = (players, playerName) => {
  const exact = players.find((player) => `${player.first_name} ${player.last_name}`.toLowerCase() === playerName.toLowerCase());
  return exact || players[0];
};

const getPlayerContext = async (state, playerName, date, statConfig) => {
  const playersResponse = await bdlFetch(state, "/v1/players", { search: playerName, per_page: 10 });
  const player = normalizePlayerSearch(playersResponse.data || [], playerName);
  if (!player) {
    throw new Error(`Could not find a player match for ${playerName}.`);
  }

  const gamesResponse = await bdlFetch(state, "/v1/games", { dates: [date], per_page: 100 });
  const games = gamesResponse.data || [];
  const game = games.find((item) => {
    const homeId = item.home_team?.id;
    const visitorId = item.visitor_team?.id;
    return homeId === player.team?.id || visitorId === player.team?.id || homeId === player.team_id || visitorId === player.team_id;
  });

  const recentStatsResponse = await bdlFetch(state, "/v1/stats", {
    player_ids: [player.id],
    per_page: 5,
    postseason: true,
  });

  const injuriesResponse = await bdlFetch(state, "/v1/player_injuries", {
    team_ids: [player.team?.id || player.team_id],
    per_page: 25,
  });

  const recentGames = summarizeRecentGames(recentStatsResponse.data || [], statConfig.statKey);
  const injuries = (injuriesResponse.data || []).slice(0, 8).map((injury) => ({
    player: `${injury.player?.first_name || ""} ${injury.player?.last_name || ""}`.trim(),
    status: injury.status,
    note: injury.description,
  }));

  let sharpLines = [];
  if (game) {
    const propsResponse = await bdlFetch(state, "/v2/odds/player_props", {
      game_id: game.id,
      player_id: player.id,
      prop_type: statConfig.propType,
      vendors: sharpVendors,
    });

    sharpLines = (propsResponse.data || [])
      .filter((prop) => prop.market?.type === "over_under")
      .map((prop) => ({
        vendor: prop.vendor,
        line: Number.parseFloat(prop.line_value),
        overOdds: prop.market?.over_odds ?? null,
        underOdds: prop.market?.under_odds ?? null,
      }))
      .filter((prop) => Number.isFinite(prop.line));
  }

  const sharpConsensus = sharpLines.length
    ? round(sharpLines.reduce((sum, item) => sum + item.line, 0) / sharpLines.length, 1)
    : null;

  return {
    player,
    game: game || null,
    recentGames,
    injuries,
    sharpLines,
    sharpConsensus,
  };
};

const buildPropAnalysis = async (state, payload) => {
  const metrics = getSummaryMetrics(state);
  const statConfig = statMap[payload.stat] || statMap.points;
  const bankroll = {
    sleeper: state.bankroll.sleeper,
    prizepicks: state.bankroll.prizepicks,
    standardSleeper: metrics.sleeperStdEntry,
    standardPrizePicks: metrics.prizePicksStdEntry,
    maxSleeper: metrics.sleeperMaxEntry,
    maxPrizePicks: metrics.prizePicksMaxEntry,
  };

  let liveContext = {
    recentGames: { average: 0, sample: 0, lastFive: "" },
    injuries: [],
    sharpLines: [],
    sharpConsensus: payload.sharpConsensus ? Number.parseFloat(payload.sharpConsensus) : null,
    game: null,
  };

  const manualRecentAverage = toNumberOrNull(payload.manualRecentAverage);
  const manualSampleSize = toNumberOrNull(payload.manualSampleSize);
  const manualMinutes = toNumberOrNull(payload.manualMinutes);
  const manualUsageChange = toNumberOrNull(payload.manualUsageChange);
  const manualInjuryBoost = payload.manualInjuryBoost || "";
  const manualMatchupGrade = payload.manualMatchupGrade || "neutral";
  const manualPaceNote = payload.manualPaceNote || "";
  const manualRoleNote = payload.manualRoleNote || "";
  const lineTimestamps = payload.lineTimestamps || {};

  if (payload.fetchLiveContext) {
    liveContext = {
      ...liveContext,
      ...(await getPlayerContext(state, payload.player, payload.date, statConfig)),
    };
  }

  if (!payload.fetchLiveContext) {
    liveContext.recentGames = {
      average: manualRecentAverage ?? 0,
      sample: manualSampleSize ?? 0,
      lastFive: payload.manualRecentLog || "",
    };
  }

  const lineSummary = getLineValueSummary({
    sleeperLine: payload.sleeperLine,
    prizePicksLine: payload.prizePicksLine,
    sharpConsensus: liveContext.sharpConsensus,
  });

  const recommendedPct =
    lineSummary.lineQuality === "SOFT" ? 10 : lineSummary.lineQuality === "NEUTRAL" ? 5 : 2.5;
  const bankrollPct = Math.min(recommendedPct, state.bankroll.maxEntryPct);
  const chasingFlag = metrics.restriction.hardBlock;
  const hasManualContextEdge = Boolean(
    (manualRecentAverage != null && manualSampleSize != null && manualSampleSize >= 3) ||
    (manualMinutes != null && manualMinutes >= 34) ||
    (manualUsageChange != null && Math.abs(manualUsageChange) >= 3) ||
    manualInjuryBoost ||
    (manualMatchupGrade && manualMatchupGrade !== "neutral") ||
    manualPaceNote ||
    manualRoleNote,
  );
  const primaryLine = toNumberOrNull(payload.sleeperLine) ?? toNumberOrNull(payload.prizePicksLine);
  const recentGap = manualRecentAverage != null && primaryLine != null ? round(manualRecentAverage - primaryLine, 1) : null;
  const finalVerdict =
    lineSummary.lineQuality === "SHARP" && !hasManualContextEdge && liveContext.recentGames.average <= Number.parseFloat(payload.sleeperLine || payload.prizePicksLine || 0)
      ? "SKIP"
      : lineSummary.lineQuality === "UNKNOWN" && liveContext.sharpConsensus == null
        ? manualSampleSize != null && manualSampleSize < 3
          ? "SKIP"
          : recentGap != null && recentGap >= 2 && hasManualContextEdge
            ? "MORE"
            : recentGap != null && recentGap <= -2
              ? "LESS"
              : "SKIP"
        : lineSummary.verdict;
  const confidence =
    lineSummary.lineQuality === "SOFT"
      ? hasManualContextEdge ? "Medium-High" : "Medium"
      : lineSummary.lineQuality === "NEUTRAL"
        ? hasManualContextEdge ? "Medium" : "Medium-Low"
        : hasManualContextEdge ? "Medium-Low" : "Low";
  const notesCount = [
    payload.manualRecentLog,
    manualInjuryBoost,
    manualPaceNote,
    manualRoleNote,
    payload.context,
  ].filter(Boolean).length;
  let aiSummary = "";
  const researchConfidence = getResearchConfidence({
    providerUsed: Boolean(payload.providerUsed),
    sharpConsensus: liveContext.sharpConsensus,
    manualRecentAverage,
    manualSampleSize,
    notesCount,
    aiSummary,
    manualMinutes,
    hasManualContextEdge,
    lineQuality: lineSummary.lineQuality,
  });
  const queueBucket = getQueueBucket({
    finalVerdict,
    lineQuality: lineSummary.lineQuality,
    hasManualContextEdge,
    sleeperLine: payload.sleeperLine,
    prizePicksLine: payload.prizePicksLine,
  });
  const bestPlayScore = getBestPlayScore({
    lineQuality: lineSummary.lineQuality,
    hasManualContextEdge,
    finalVerdict,
    sharpConsensus: liveContext.sharpConsensus,
    researchConfidence,
  });

  const manualPlayerNotes = [
    manualRecentAverage != null ? `Recent average: ${manualRecentAverage} over ${manualSampleSize || 0} games.` : "",
    payload.manualRecentLog ? `Recent log: ${payload.manualRecentLog}.` : "",
    manualMinutes != null ? `Expected minutes: ${manualMinutes}.` : "",
    manualUsageChange != null ? `Usage change: ${manualUsageChange >= 0 ? "+" : ""}${manualUsageChange}%.` : "",
    manualInjuryBoost ? `Injury impact: ${manualInjuryBoost}.` : "",
    manualMatchupGrade !== "neutral" ? `Matchup grade: ${manualMatchupGrade}.` : "",
    manualPaceNote ? `Pace note: ${manualPaceNote}.` : "",
    manualRoleNote ? `Role note: ${manualRoleNote}.` : "",
  ].filter(Boolean);

  if (state.settings.aiAnalysisEnabled && getApiKeys(state).openai && payload.useAi) {
    const client = createOpenAIClient(state);
    const response = await client.responses.create({
      model: OPENAI_MODEL,
      tools: [{ type: "web_search" }],
      tool_choice: "auto",
      input: buildSearchPrompt({
        player: payload.player,
        stat: payload.stat,
        context: payload.context,
        lineSummary,
        injuries: liveContext.injuries,
        recentGames: liveContext.recentGames,
        bankroll,
      }),
    });
    aiSummary = parseOpenAIText(response);
  }

  return {
    lineSummary,
    liveContext,
    bankroll: {
      recommendedPct: bankrollPct,
      sleeperAmount: round((state.bankroll.sleeper * bankrollPct) / 100),
      prizePicksAmount: round((state.bankroll.prizepicks * bankrollPct) / 100),
      standardSleeper: metrics.sleeperStdEntry,
      standardPrizePicks: metrics.prizePicksStdEntry,
      maxSleeper: metrics.sleeperMaxEntry,
      maxPrizePicks: metrics.prizePicksMaxEntry,
    },
    finalVerdict,
    confidence,
    researchConfidence,
    queueBucket,
    bestPlayScore,
    chasingFlag,
    aiSummary,
    playerContextSummary: manualPlayerNotes.length
      ? manualPlayerNotes.join(" ")
      : "No structured manual player context entered yet.",
    lineTimestamps,
    preLockChecklist: [
      payload.sleeperLine ? `Confirm Sleeper ${payload.stat} line is still ${payload.sleeperLine}.` : "Add the current Sleeper line before submitting.",
      payload.prizePicksLine ? `Confirm PrizePicks ${payload.stat} line is still ${payload.prizePicksLine}.` : "Add the current PrizePicks line before submitting.",
      "Confirm the player is starting or keeping the expected rotation role.",
      "Confirm there is no late injury or minutes-cap update.",
      `Keep the entry at or below ${bankrollPct}% unless this becomes a clear skip.`,
    ],
    checklist: [
      "Line value check completed before player context.",
      liveContext.sharpConsensus == null
        ? "Sharp consensus missing, so treat this as manual-only until confirmed."
        : payload.fetchLiveContext
          ? "Sharp consensus pulled from live sportsbook data."
          : "Sharp consensus entered manually.",
      liveContext.injuries.length
        ? `Injury monitor: ${liveContext.injuries.length} relevant team injury notes found.`
        : payload.fetchLiveContext
          ? "No injury notes returned for the player's team."
          : "Player context is manual right now, so confirm injuries and role yourself before placing an entry.",
      manualPlayerNotes.length
        ? "Structured manual player-analysis notes were included in the verdict."
        : "No structured manual player-analysis notes were included yet.",
      `Research confidence is ${researchConfidence}.`,
      chasingFlag ? metrics.restriction.message : "No chasing block active right now.",
    ],
  };
};

const buildEntryAnalysis = async (state, payload) => {
  const metrics = getSummaryMetrics(state);
  const platform = payload.platform;
  const bankroll = platform === "Sleeper" ? state.bankroll.sleeper : state.bankroll.prizepicks;
  const standardSize = platform === "Sleeper" ? metrics.sleeperStdEntry : metrics.prizePicksStdEntry;
  const maxSize = platform === "Sleeper" ? metrics.sleeperMaxEntry : metrics.prizePicksMaxEntry;
  const moreCount = payload.picks.filter((pick) => pick.lean === "MORE").length;
  const lessCount = payload.picks.filter((pick) => pick.lean === "LESS").length;
  const sameTeamNames = payload.picks.map((pick) => pick.team || "").filter(Boolean);
  const sameTeamExposure = sameTeamNames.length > 0 && new Set(sameTeamNames).size < sameTeamNames.length;
  const action =
    metrics.restriction.hardBlock ? "SKIP" : payload.picks.length === 2 && moreCount > 0 && lessCount > 0 ? "ADJUST" : "PLAY IT";

  let aiSummary = "";
  if (state.settings.aiAnalysisEnabled && getApiKeys(state).openai && payload.useAi) {
    const client = createOpenAIClient(state);
    const response = await client.responses.create({
      model: OPENAI_MODEL,
      reasoning: { effort: "low" },
      input: `Analyze this ${payload.picks.length}-pick ${platform} NBA props entry. Picks: ${JSON.stringify(payload.picks)}. Bankroll: ${bankroll}. Standard size: ${standardSize}. Max size: ${maxSize}. Respect Ant's order: line value first, player analysis second, bankroll sizing third. Return 4-6 concise sentences ending with exactly one of PLAY IT / ADJUST / SKIP.`,
    });
    aiSummary = parseOpenAIText(response);
  }

  return {
    platform,
    bankroll,
    standardSize,
    maxSize,
    sameTeamExposure,
    action,
    confidence: payload.picks.length === 2 ? "Medium" : "Medium-Low",
    guidance: [
      metrics.restriction.message || "No chase restriction active.",
      sameTeamExposure
        ? "Correlated team exposure detected. Make sure you are not betting one game script twice."
        : "No obvious same-team overlap detected in the current ticket.",
      payload.picks.length === 3
        ? "Three-pick entries need three real edges. Do not force the third leg."
        : "Two-pick entries remain the safest format for this bankroll.",
      `Stay near the standard $${standardSize.toFixed(2)} size and never above the hard cap of $${maxSize.toFixed(2)}.`,
    ],
    aiSummary,
  };
};

const getNightlySession = (state) => {
  const metrics = getSummaryMetrics(state);
  const today = new Date().toISOString().slice(0, 10);
  const todayEntries = state.entries.filter((entry) => entry.timestamp?.startsWith(today));

  return {
    title: "Nightly Session Workflow",
    status: metrics.restriction.hardBlock ? "locked" : "ready",
    steps: [
      {
        label: "1. Refresh Slate",
        detail: "Pull tonight's games, check injury context, and confirm which props are actually worth manual line checking.",
        done: false,
      },
      {
        label: "2. Run Line Cards",
        detail: "For every target prop, compare Sleeper or PrizePicks to sharp consensus before writing any player notes.",
        done: false,
      },
      {
        label: "3. Narrow Entry Pool",
        detail: "Only carry forward props that still look soft after recent form and injury context.",
        done: false,
      },
      {
        label: "4. Size One Ticket",
        detail: `Default size is 10% per platform. Tonight's standards are $${metrics.sleeperStdEntry.toFixed(2)} Sleeper and $${metrics.prizePicksStdEntry.toFixed(2)} PrizePicks.`,
        done: false,
      },
      {
        label: "5. Log the Result",
        detail: `${todayEntries.length} entries logged today. Keep the history current so chasing safeguards stay honest.`,
        done: todayEntries.length > 0,
      },
    ],
    guardrail: metrics.restriction.message || "No active chase warning.",
  };
};

const getSlate = async (state, date, days = 1) => {
  const dates = Array.from({ length: Math.max(1, days) }, (_, index) => addDays(date, index));
  const gamesResponse = await bdlFetch(state, "/v1/games", {
    dates,
    per_page: 100,
  });
  let odds = [];
  let injuries = [];
  const warnings = [];

  try {
    const oddsResponse = await bdlFetch(state, "/v2/odds", {
      dates,
      per_page: 100,
    });
    odds = oddsResponse.data || [];
  } catch (error) {
    if (isAuthOrTierError(error)) {
      warnings.push("BallDontLie free tier does not include betting odds, so totals and spreads stay manual.");
    } else {
      warnings.push(`Odds unavailable right now: ${error.message}`);
    }
  }

  try {
    const injuriesResponse = await bdlFetch(state, "/v1/player_injuries", {
      per_page: 100,
    });
    injuries = injuriesResponse.data || [];
  } catch (error) {
    if (isAuthOrTierError(error)) {
      warnings.push("BallDontLie free tier does not include player injuries, so injury checks stay manual.");
    } else {
      warnings.push(`Injuries unavailable right now: ${error.message}`);
    }
  }

  const games = gamesResponse.data || [];
  const mode = odds.length || injuries.length ? "hybrid" : "free-tier-manual";

  const slate = games.map((game) => {
    const gameOdds = odds.filter((item) => item.id === game.id);
    const totals = [];
    const spreads = [];

    gameOdds.forEach((book) => {
      (book.bookmakers || []).forEach((bookmaker) => {
        (bookmaker.markets || []).forEach((market) => {
          if (market.key === "totals") {
            const totalOutcome = market.outcomes?.find((outcome) => typeof outcome.point === "number");
            if (totalOutcome) totals.push(totalOutcome.point);
          }

          if (market.key === "spreads") {
            const homeOutcome = market.outcomes?.find((outcome) => outcome.name === game.home_team?.full_name);
            if (homeOutcome && typeof homeOutcome.point === "number") spreads.push(homeOutcome.point);
          }
        });
      });
    });

    const relatedInjuries = injuries.filter((injury) => {
      const teamId = injury.player?.team_id;
      return teamId === game.home_team?.id || teamId === game.visitor_team?.id;
    });

    return {
      id: game.id,
      date: game.datetime ? new Date(game.datetime).toISOString().slice(0, 10) : date,
      matchup: `${game.visitor_team?.abbreviation} @ ${game.home_team?.abbreviation}`,
      start: game.datetime,
      status: game.status,
      postseason: game.postseason,
      consensusTotal: totals.length ? round(totals.reduce((sum, value) => sum + value, 0) / totals.length, 1) : null,
      homeSpread: spreads.length ? round(spreads.reduce((sum, value) => sum + value, 0) / spreads.length, 1) : null,
      injuryCount: relatedInjuries.length,
      manualOddsCheck: totals.length === 0 && spreads.length === 0,
      manualInjuryCheck: relatedInjuries.length === 0,
      injuryHighlights: relatedInjuries.slice(0, 4).map((injury) => ({
        player: `${injury.player?.first_name || ""} ${injury.player?.last_name || ""}`.trim(),
        status: injury.status,
      })),
    };
  });

  return {
    mode,
    warnings,
    requestedDates: dates,
    slate,
  };
};

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

app.get("/api/bootstrap", async (req, res) => {
  res.json(appSnapshot(await readState()));
});

app.get("/api/nightly-session", async (req, res) => {
  res.json(getNightlySession(await readState()));
});

app.get("/api/slate", async (req, res) => {
  try {
    const state = await readState();
    const date = req.query.date || state.settings.preferredDate || new Date().toISOString().slice(0, 10);
    const days = Number.parseInt(req.query.days || "1", 10);
    const result = await getSlate(state, date, Number.isFinite(days) ? Math.min(Math.max(days, 1), 5) : 1);
    res.json({ date, ...result });
  } catch (error) {
    res.status(400).json({ error: error.message || "Failed to load slate." });
  }
});

app.post("/api/line-check", async (req, res) => {
  try {
    const state = await readState();
    const statConfig = statMap[req.body.stat] || statMap.points;
    const context = await getPlayerContext(
      state,
      req.body.player,
      req.body.date || state.settings.preferredDate || new Date().toISOString().slice(0, 10),
      statConfig,
    );
    res.json(context);
  } catch (error) {
    res.status(400).json({ error: error.message || "Failed to check live lines." });
  }
});

app.post("/api/analyze/prop", async (req, res) => {
  try {
    const state = await readState();
    if (getRestriction(state).hardBlock) {
      return res.status(400).json({ error: getRestriction(state).message });
    }

    const analysis = await buildPropAnalysis(state, req.body);
    res.json(analysis);
  } catch (error) {
    res.status(400).json({ error: error.message || "Failed to analyze prop." });
  }
});

app.post("/api/providers/autofill-prop", async (req, res) => {
  try {
    const state = await readState();
    const result = await buildProviderAutofill(state, req.body);
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error.message || "Provider auto-fill failed." });
  }
});

app.post("/api/research/player-context", async (req, res) => {
  try {
    const state = await readState();
    const result = await buildAiPlayerResearch(state, req.body);
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error.message || "AI player research failed." });
  }
});

app.post("/api/research/game-roster", async (req, res) => {
  try {
    const state = await readState();
    const result = await buildAiGameRoster(state, req.body);
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error.message || "AI game roster research failed." });
  }
});

app.post("/api/analyze/entry", async (req, res) => {
  try {
    const state = await readState();
    if (getRestriction(state).hardBlock) {
      return res.status(400).json({ error: getRestriction(state).message });
    }

    const analysis = await buildEntryAnalysis(state, req.body);
    res.json(analysis);
  } catch (error) {
    res.status(400).json({ error: error.message || "Failed to analyze entry." });
  }
});

app.post("/api/props/save", async (req, res) => {
  const prop = req.body;
  const timestamp = new Date().toISOString();
  const id = prop.id || getPropId(prop);
  const next = await updateState((next) => {
    const existingIndex = next.props.findIndex((item) => item.id === id);
    const previous = existingIndex >= 0 ? next.props[existingIndex] : null;
    const lineHistory = Array.isArray(previous?.lineHistory) ? [...previous.lineHistory] : [];

    const currentSnapshot = {
      timestamp,
      sleeperLine: prop.sleeperLine || "",
      prizePicksLine: prop.prizePicksLine || "",
      sharpConsensus: prop.sharpConsensus || "",
    };

    const lastSnapshot = lineHistory[lineHistory.length - 1];
    if (
      !lastSnapshot ||
      lastSnapshot.sleeperLine !== currentSnapshot.sleeperLine ||
      lastSnapshot.prizePicksLine !== currentSnapshot.prizePicksLine ||
      lastSnapshot.sharpConsensus !== currentSnapshot.sharpConsensus
    ) {
      lineHistory.push(currentSnapshot);
    }

    const savedProp = {
      ...previous,
      ...prop,
      id,
      updatedAt: timestamp,
      createdAt: previous?.createdAt || timestamp,
      bucket: prop.queueBucket || prop.bucket || "watch",
      lineHistory,
    };

    if (existingIndex >= 0) {
      next.props[existingIndex] = savedProp;
    } else {
      next.props.unshift(savedProp);
    }
    return next;
  });
  res.json(appSnapshot(next));
});

app.post("/api/journal", async (req, res) => {
  const next = await updateState((next) => {
    next.journal.unshift({
      id: `${Date.now()}`,
      date: req.body.date || new Date().toISOString().slice(0, 10),
      title: req.body.title || "Slate note",
      body: req.body.body || "",
      tags: Array.isArray(req.body.tags) ? req.body.tags : [],
      createdAt: new Date().toISOString(),
    });
    return next;
  });
  res.json(appSnapshot(next));
});

app.post("/api/settings", async (req, res) => {
  const next = await updateState((current) => {
    const next = {
      ...current,
      bankroll: {
        ...current.bankroll,
        entryPct: clampPercent(req.body.entryPct ?? current.bankroll.entryPct, current.bankroll.entryPct),
        maxEntryPct: clampPercent(req.body.maxEntryPct ?? current.bankroll.maxEntryPct, current.bankroll.maxEntryPct),
      },
      settings: {
        ...current.settings,
        openaiApiKey: String(req.body.openaiApiKey ?? current.settings.openaiApiKey ?? "").trim(),
        ballDontLieApiKey: String(req.body.ballDontLieApiKey ?? current.settings.ballDontLieApiKey ?? "").trim(),
        oddsApiKey: String(req.body.oddsApiKey ?? current.settings.oddsApiKey ?? "").trim(),
        oddsProvider: req.body.oddsProvider || current.settings.oddsProvider || "manual",
        aiAnalysisEnabled: Boolean(req.body.aiAnalysisEnabled),
        autoLoadSlate: Boolean(req.body.autoLoadSlate),
        preferredDate: req.body.preferredDate || current.settings.preferredDate,
        notes: req.body.notes ?? current.settings.notes,
      },
    };
    next.bankroll.entryPct = Math.min(next.bankroll.entryPct, next.bankroll.maxEntryPct);
    return next;
  });
  res.json(appSnapshot(next));
});

app.post("/api/bankroll", async (req, res) => {
  const platformKey = req.body.platform === "PrizePicks" ? "prizepicks" : "sleeper";
  const nextAmount = Number.parseFloat(req.body.amount);
  if (!Number.isFinite(nextAmount) || nextAmount < 0) {
    return res.status(400).json({ error: "Enter a valid non-negative bankroll amount." });
  }

  const next = await updateState((next) => ({
    ...next,
    bankroll: {
      ...next.bankroll,
      [platformKey]: nextAmount,
    },
  }));
  res.json(appSnapshot(next));
});

app.post("/api/entries", async (req, res) => {
  const current = await readState();
  const platform = req.body.platform === "PrizePicks" ? "PrizePicks" : "Sleeper";
  const bankrollKey = platform === "PrizePicks" ? "prizepicks" : "sleeper";
  const winsKey = platform === "PrizePicks" ? "prizePicksWins" : "sleeperWins";
  const lossesKey = platform === "PrizePicks" ? "prizePicksLosses" : "sleeperLosses";
  const entry = Number.parseFloat(req.body.entry);
  const payout = Number.parseFloat(req.body.payout || 0);

  if (!req.body.picks || !Number.isFinite(entry) || entry <= 0) {
    return res.status(400).json({ error: "Enter picks and a valid entry amount before logging." });
  }

  const maxEntry = getMaxEntry(current.bankroll[bankrollKey], current.bankroll.maxEntryPct);
  if (entry > maxEntry) {
    return res.status(400).json({ error: `Entry exceeds the ${current.bankroll.maxEntryPct}% cap for ${platform}. Max allowed is $${maxEntry.toFixed(2)}.` });
  }

  if (req.body.result === "WIN" && payout <= 0) {
    return res.status(400).json({ error: "Winning entries need a payout amount." });
  }

  const pnl = req.body.result === "WIN" ? payout - entry : -entry;
  const timestamp = new Date().toISOString();
  const next = await updateState((next) => {
    next.entries.unshift({
      date: timestamp.slice(0, 10),
      timestamp,
      platform,
      picks: req.body.picks,
      entry,
      result: req.body.result,
      payout: req.body.result === "WIN" ? payout : 0,
      pnl,
    });

    next.bankroll[bankrollKey] = Math.max(0, round(next.bankroll[bankrollKey] + pnl));
    next.record[winsKey] = req.body.result === "WIN" ? next.record[winsKey] + 1 : next.record[winsKey];
    next.record[lossesKey] = req.body.result === "LOSS" ? next.record[lossesKey] + 1 : next.record[lossesKey];
    next.record.consecutiveLosses = req.body.result === "LOSS" ? next.record.consecutiveLosses + 1 : 0;
    next.record.lastLossAt = req.body.result === "LOSS" ? timestamp : next.record.lastLossAt;
    return next;
  });
  res.json(appSnapshot(next));
});

if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));
  app.get(/^(?!\/api).*/, (req, res) => {
    res.sendFile(path.join(distDir, "index.html"));
  });
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === __filename;

if (isDirectRun) {
  if (!shouldUseBlobStorage()) {
    ensureStorage();
  }
  app.listen(port, () => {
    console.log(`Picks backend running on http://localhost:${port}`);
  });
}

export default app;
