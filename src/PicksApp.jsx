import { useCallback, useEffect, useMemo, useState } from "react";
import "./App.css";

const initialPropForm = {
  player: "",
  stat: "points",
  sleeperLine: "",
  prizePicksLine: "",
  sharpConsensus: "",
  teamTag: "",
  date: new Date().toISOString().slice(0, 10),
  manualRecentAverage: "",
  manualSampleSize: "",
  manualRecentLog: "",
  manualMinutes: "",
  manualUsageChange: "",
  manualInjuryBoost: "",
  manualMatchupGrade: "neutral",
  manualPaceNote: "",
  manualRoleNote: "",
  lineTimestamps: {},
  context: "",
};

const initialEntryForm = {
  player: "",
  stat: "",
  lean: "MORE",
  app: "Sleeper",
  team: "",
};

const initialLogForm = {
  platform: "Sleeper",
  picks: "",
  entry: "",
  result: "WIN",
  payout: "",
};

const statOptions = [
  "points",
  "rebounds",
  "assists",
  "3-pointers made",
  "steals",
  "blocks",
  "pra",
];

const safeCurrency = (value) => `$${Number(value || 0).toFixed(2)}`;

const request = async (url, options = {}) => {
  const response = await fetch(url, {
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
    ...options,
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
    throw new Error(data?.error || raw?.trim() || "Request failed.");
  }

  return data ?? {};
};

const formatDateTime = (value) => {
  if (!value) return "TBD";
  const date = new Date(value);
  return date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
};

function MetricCard({ label, value, tone = "neutral", caption }) {
  return (
    <div className={`metric-card ${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      {caption ? <small>{caption}</small> : null}
    </div>
  );
}

function SectionHeader({ eyebrow, title, body, actions }) {
  return (
    <div className="section-header">
      <div>
        <p className="eyebrow">{eyebrow}</p>
        <h2>{title}</h2>
        {body ? <p className="section-copy">{body}</p> : null}
      </div>
      {actions ? <div className="section-actions">{actions}</div> : null}
    </div>
  );
}

function Alert({ tone = "info", children }) {
  return <div className={`alert ${tone}`}>{children}</div>;
}

function StatSelector({ options, value, onSelect }) {
  return (
    <div className="stat-selector">
      {options.map((option) => (
        <button
          key={option}
          className={`stat-pill ${value === option ? "active" : ""}`}
          onClick={() => onSelect(option)}
          type="button"
        >
          {option}
        </button>
      ))}
    </div>
  );
}

function ResearchSignalChip({ label, value, tone = "muted" }) {
  return (
    <span className={`chip ${tone}`}>
      {label}: {value}
    </span>
  );
}

export default function PicksApp() {
  const [snapshot, setSnapshot] = useState(null);
  const [activeTab, setActiveTab] = useState("slate");
  const [nightlySession, setNightlySession] = useState(null);
  const [slate, setSlate] = useState([]);
  const [slateLoading, setSlateLoading] = useState(false);
  const [slateMessage, setSlateMessage] = useState("");
  const [slateWarnings, setSlateWarnings] = useState([]);
  const [slateDays, setSlateDays] = useState("3");
  const [selectedGame, setSelectedGame] = useState(null);
  const [gameRoster, setGameRoster] = useState(null);
  const [gameRosterLoading, setGameRosterLoading] = useState(false);
  const [gameRosterMessage, setGameRosterMessage] = useState("");
  const [propForm, setPropForm] = useState(initialPropForm);
  const [propAnalysis, setPropAnalysis] = useState(null);
  const [propLoading, setPropLoading] = useState(false);
  const [providerLoading, setProviderLoading] = useState(false);
  const [researchLoading, setResearchLoading] = useState(false);
  const [propMessage, setPropMessage] = useState("");
  const [entryForm, setEntryForm] = useState(initialEntryForm);
  const [entryPicks, setEntryPicks] = useState([]);
  const [entryAnalysis, setEntryAnalysis] = useState(null);
  const [entryLoading, setEntryLoading] = useState(false);
  const [entryMessage, setEntryMessage] = useState("");
  const [logForm, setLogForm] = useState(initialLogForm);
  const [settingsForm, setSettingsForm] = useState({
    openaiApiKey: "",
    ballDontLieApiKey: "",
    oddsApiKey: "",
    oddsProvider: "manual",
    aiAnalysisEnabled: false,
    autoLoadSlate: false,
    preferredDate: new Date().toISOString().slice(0, 10),
    entryPct: 10,
    maxEntryPct: 20,
    notes: "",
  });
  const [bankrollInputs, setBankrollInputs] = useState({ sleeper: "25.00", prizepicks: "25.00" });
  const [settingsMessage, setSettingsMessage] = useState("");
  const [historyMessage, setHistoryMessage] = useState("");
  const [journalTitle, setJournalTitle] = useState("");
  const [journalBody, setJournalBody] = useState("");

  const applySnapshot = useCallback((data) => {
    setSnapshot(data);
    setSettingsForm({
      openaiApiKey: data.settings.openaiApiKey || "",
      ballDontLieApiKey: data.settings.ballDontLieApiKey || "",
      oddsApiKey: data.settings.oddsApiKey || "",
      oddsProvider: data.settings.oddsProvider || "manual",
      aiAnalysisEnabled: data.settings.aiAnalysisEnabled,
      autoLoadSlate: data.settings.autoLoadSlate,
      preferredDate: data.settings.preferredDate || new Date().toISOString().slice(0, 10),
      entryPct: data.bankroll.entryPct,
      maxEntryPct: data.bankroll.maxEntryPct,
      notes: data.settings.notes || "",
    });
    setBankrollInputs({
      sleeper: Number(data.bankroll.sleeper || 0).toFixed(2),
      prizepicks: Number(data.bankroll.prizepicks || 0).toFixed(2),
    });
    setPropForm((current) => ({
      ...current,
      date: data.settings.preferredDate || current.date,
    }));
  }, []);

  const refreshNightlySession = useCallback(async () => {
    const data = await request("/api/nightly-session");
    setNightlySession(data);
  }, []);

  const loadSlate = useCallback(async (dateOverride) => {
    if (!snapshot?.capabilities.ballDontLieConfigured) {
      setSlate([]);
      setSlateWarnings([]);
      setSlateMessage("Add a BallDontLie API key in Settings to load tonight's games, consensus totals, and injury counts.");
      return;
    }

    setSlateLoading(true);
    setSlateMessage("");
    try {
      const targetDate = dateOverride || settingsForm.preferredDate;
      const data = await request(`/api/slate?date=${encodeURIComponent(targetDate)}&days=${encodeURIComponent(slateDays)}`);
      setSlate(data.slate);
      setSelectedGame(null);
      setGameRoster(null);
      setGameRosterMessage("");
      setSlateWarnings(data.warnings || []);
      if (!data.slate.length) {
        setSlateMessage(`No games returned starting from ${targetDate}.`);
      } else if (data.mode === "free-tier-manual") {
        setSlateMessage(`Loaded ${data.slate.length} games across the next ${slateDays} day(s) starting ${targetDate}. Free-tier mode is active, so odds and injuries stay manual.`);
      } else {
        setSlateMessage(`Loaded ${data.slate.length} games across the next ${slateDays} day(s) starting ${targetDate}.`);
      }
    } catch (error) {
      setSlateMessage(error.message);
      setSlateWarnings([]);
      setSlate([]);
    } finally {
      setSlateLoading(false);
    }
  }, [settingsForm.preferredDate, slateDays, snapshot?.capabilities.ballDontLieConfigured]);

  useEffect(() => {
    let active = true;

    const initialize = async () => {
      try {
        const data = await request("/api/bootstrap");
        if (!active) return;
        applySnapshot(data);
        await refreshNightlySession();
        if (data.settings.autoLoadSlate) {
          await loadSlate(data.settings.preferredDate);
        }
      } catch (error) {
        if (active) {
          setSlateMessage(error.message);
        }
      }
    };

    initialize();
    return () => {
      active = false;
    };
  }, [applySnapshot, loadSlate, refreshNightlySession]);

  const restriction = snapshot?.metrics?.restriction;
  const recordSummary = useMemo(() => {
    if (!snapshot) return null;
    return [
      {
        label: "Sleeper",
        value: safeCurrency(snapshot.bankroll.sleeper),
        caption: `${snapshot.record.sleeperWins}-${snapshot.record.sleeperLosses}`,
      },
      {
        label: "PrizePicks",
        value: safeCurrency(snapshot.bankroll.prizepicks),
        caption: `${snapshot.record.prizePicksWins}-${snapshot.record.prizePicksLosses}`,
      },
      {
        label: "Total Roll",
        value: safeCurrency(snapshot.metrics.totalBankroll),
        caption: "Split bankroll discipline",
      },
    ];
  }, [snapshot]);

  const groupedSlate = useMemo(() => {
    return slate.reduce((groups, game) => {
      const key = game.date || "Unknown";
      if (!groups[key]) groups[key] = [];
      groups[key].push(game);
      return groups;
    }, {});
  }, [slate]);

  const saveSettings = async () => {
    try {
      const next = await request("/api/settings", {
        method: "POST",
        body: JSON.stringify(settingsForm),
      });
      setSnapshot(next);
      setSettingsMessage("Settings saved to the backend.");
      refreshNightlySession();
    } catch (error) {
      setSettingsMessage(error.message);
    }
  };

  const updateBankroll = async (platform) => {
    try {
      const next = await request("/api/bankroll", {
        method: "POST",
        body: JSON.stringify({
          platform,
          amount: platform === "Sleeper" ? bankrollInputs.sleeper : bankrollInputs.prizepicks,
        }),
      });
      setSnapshot(next);
      setHistoryMessage(`${platform} bankroll updated.`);
    } catch (error) {
      setHistoryMessage(error.message);
    }
  };

  const runManualLineCheck = () => {
    if (!propForm.player || (!propForm.sleeperLine && !propForm.prizePicksLine)) {
      setPropMessage("Add a player and at least one platform line before checking the card.");
      return;
    }

    setPropAnalysis(null);
    setPropMessage(
      propForm.sharpConsensus
        ? "Manual line check saved. The workflow will compare your entries against the manual sharp number you provided."
        : "Manual line check saved. Add an optional sharp consensus line if you want a stronger line-value comparison."
    );
  };

  const autofillFromProvider = async () => {
    if (!propForm.player) {
      setPropMessage("Add a player before using provider auto-fill.");
      return;
    }

    setProviderLoading(true);
    setPropMessage("");
    try {
      const data = await request("/api/providers/autofill-prop", {
        method: "POST",
        body: JSON.stringify({
          player: propForm.player,
          stat: propForm.stat,
          date: propForm.date,
        }),
      });

      setPropForm((current) => ({
        ...current,
        prizePicksLine: data.suggestedPrizePicksLine != null ? String(data.suggestedPrizePicksLine) : current.prizePicksLine,
        sharpConsensus: data.suggestedSharpConsensus != null ? String(data.suggestedSharpConsensus) : current.sharpConsensus,
        context: [current.context, ...(data.sourceNotes || [])].filter(Boolean).join("\n"),
      }));
      setPropMessage(
        data.suggestedPrizePicksLine != null || data.suggestedSharpConsensus != null
          ? "Provider auto-fill added available lines to the card. Review them before running the workflow."
          : "Provider lookup ran, but it did not return any fillable lines for this prop."
      );
    } catch (error) {
      setPropMessage(error.message);
    } finally {
      setProviderLoading(false);
    }
  };

  const researchPlayerContext = async (playerOverride) => {
    const player = playerOverride || propForm.player;
    if (!player) {
      setPropMessage("Add a player before using AI research.");
      return;
    }

    setResearchLoading(true);
    setPropMessage("");
    try {
      const data = await request("/api/research/player-context", {
        method: "POST",
        body: JSON.stringify({
          player,
          stat: propForm.stat,
          date: propForm.date,
          sleeperLine: propForm.sleeperLine,
          prizePicksLine: propForm.prizePicksLine,
          sharpConsensus: propForm.sharpConsensus,
        }),
      });

      setPropForm((current) => ({
        ...current,
        manualRecentAverage: data.recentAverage != null ? String(data.recentAverage) : current.manualRecentAverage,
        manualSampleSize: data.sampleSize != null ? String(data.sampleSize) : current.manualSampleSize,
        manualRecentLog: data.recentGameLog || current.manualRecentLog,
        manualMinutes: data.expectedMinutes != null ? String(data.expectedMinutes) : current.manualMinutes,
        manualUsageChange: data.usageChangePct != null ? String(data.usageChangePct) : current.manualUsageChange,
        manualMatchupGrade: data.matchupGrade || current.manualMatchupGrade,
        manualInjuryBoost: data.injuryBoost || current.manualInjuryBoost,
        manualPaceNote: data.paceNote || current.manualPaceNote,
        manualRoleNote: data.roleNote || current.manualRoleNote,
        context: [current.context, data.sourceNotes].filter(Boolean).join("\n"),
      }));
      setPropMessage("AI research filled the player-context fields. Review the values and source notes before running the workflow.");
    } catch (error) {
      setPropMessage(error.message);
    } finally {
      setResearchLoading(false);
    }
  };

  const researchWithAi = async () => {
    await researchPlayerContext();
  };

  const loadGameRoster = async (game) => {
    setSelectedGame(game);
    setGameRoster(null);
    setGameRosterLoading(true);
    setGameRosterMessage("");

    const [awayTeam, homeTeam] = game.matchup.split(" @ ");

    try {
      const data = await request("/api/research/game-roster", {
        method: "POST",
        body: JSON.stringify({
          date: propForm.date || settingsForm.preferredDate,
          matchup: game.matchup,
          homeTeam,
          awayTeam,
        }),
      });
      setGameRoster(data);
      setGameRosterMessage("Roster research loaded. Pick a player to fill the workflow card.");
    } catch (error) {
      setGameRosterMessage(error.message);
    } finally {
      setGameRosterLoading(false);
    }
  };

  const chooseGamePlayer = async (playerName, teamName) => {
    setActiveTab("prop");
    setPropForm((current) => ({
      ...current,
      player: playerName,
      teamTag: teamName,
      date: settingsForm.preferredDate,
      context: [current.context, selectedGame ? `Selected from ${selectedGame.matchup}. Team: ${teamName}.` : ""].filter(Boolean).join("\n"),
    }));
    setPropMessage(`Loaded ${playerName} into the workflow card. Running AI research for ${propForm.stat}.`);
    await researchPlayerContext(playerName);
  };

  const selectStat = (stat) => {
    setPropForm((current) => ({
      ...current,
      stat,
    }));
    setPropMessage(`Stat changed to ${stat}. Enter lines for this category or rerun AI research if you want stat-specific context refreshed.`);
  };

  const updateLineField = (field, value) => {
    setPropForm((current) => ({
      ...current,
      [field]: value,
      lineTimestamps: {
        ...current.lineTimestamps,
        [field]: new Date().toISOString(),
      },
    }));
  };

  const analyzeProp = async () => {
    setPropLoading(true);
    setPropMessage("");
    setPropAnalysis(null);
    try {
      const data = await request("/api/analyze/prop", {
        method: "POST",
        body: JSON.stringify({
          ...propForm,
          fetchLiveContext: false,
          useAi: Boolean(snapshot?.capabilities.openaiConfigured && settingsForm.aiAnalysisEnabled),
        }),
      });
      setPropAnalysis(data);
    } catch (error) {
      setPropMessage(error.message);
    } finally {
      setPropLoading(false);
    }
  };

  const saveCurrentProp = async () => {
    if (!propForm.player) {
      setPropMessage("Pick a player before saving a prop card.");
      return;
    }

    const payload = {
      ...propForm,
      ...(propAnalysis || {}),
      id: [propForm.date, propForm.player, propForm.stat].join("__"),
      bucket: propAnalysis?.queueBucket || (!propForm.sleeperLine && !propForm.prizePicksLine ? "need-line" : "watch"),
    };

    try {
      const next = await request("/api/props/save", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      setSnapshot(next);
      setPropMessage("Prop card saved to your queue.");
    } catch (error) {
      setPropMessage(error.message);
    }
  };

  const addCurrentPropToEntry = () => {
    if (!propForm.player || !propForm.stat) {
      setPropMessage("Pick a player and stat before adding to the entry builder.");
      return;
    }

    const lean = propAnalysis?.finalVerdict === "LESS" ? "LESS" : "MORE";
    const app = propAnalysis?.lineSummary?.bestApp === "PrizePicks" ? "PrizePicks" : "Sleeper";
    const pick = {
      player: propForm.player,
      stat: propForm.stat,
      lean,
      app,
      team: propForm.teamTag || "",
    };

    setEntryPicks((current) => {
      if (current.length >= 3) return current;
      if (current.length > 0 && current[0].app !== pick.app) return current;
      if (current.some((item) => item.player === pick.player && item.stat === pick.stat && item.lean === pick.lean)) return current;
      return [...current, pick];
    });
    setActiveTab("entry");
    setEntryMessage(`Added ${propForm.player} ${propForm.stat} ${lean} to the entry builder.`);
  };

  const saveJournalEntry = async () => {
    if (!journalTitle && !journalBody) {
      setHistoryMessage("Add a journal title or note before saving.");
      return;
    }

    try {
      const next = await request("/api/journal", {
        method: "POST",
        body: JSON.stringify({
          date: settingsForm.preferredDate,
          title: journalTitle || "Slate note",
          body: journalBody,
          tags: [selectedGame?.matchup || "", propForm.player || ""].filter(Boolean),
        }),
      });
      setSnapshot(next);
      setJournalTitle("");
      setJournalBody("");
      setHistoryMessage("Journal note saved.");
    } catch (error) {
      setHistoryMessage(error.message);
    }
  };

  const addEntryPick = () => {
    if (!entryForm.player || !entryForm.stat) {
      setEntryMessage("Add a player and stat before adding the leg.");
      return;
    }

    if (entryPicks.length >= 3) {
      setEntryMessage("Keep entries to a maximum of three legs.");
      return;
    }

    if (entryPicks.length > 0 && entryPicks[0].app !== entryForm.app) {
      setEntryMessage("Each ticket must stay on one platform.");
      return;
    }

    setEntryPicks((current) => [...current, entryForm]);
    setEntryForm(initialEntryForm);
    setEntryMessage("");
  };

  const analyzeEntry = async () => {
    setEntryLoading(true);
    setEntryAnalysis(null);
    setEntryMessage("");
    try {
      const data = await request("/api/analyze/entry", {
        method: "POST",
        body: JSON.stringify({
          platform: entryPicks[0]?.app || entryForm.app,
          picks: entryPicks,
          useAi: Boolean(snapshot?.capabilities.openaiConfigured && settingsForm.aiAnalysisEnabled),
        }),
      });
      setEntryAnalysis(data);
    } catch (error) {
      setEntryMessage(error.message);
    } finally {
      setEntryLoading(false);
    }
  };

  const logEntry = async () => {
    try {
      const next = await request("/api/entries", {
        method: "POST",
        body: JSON.stringify(logForm),
      });
      setSnapshot(next);
      setLogForm(initialLogForm);
      setHistoryMessage("Entry logged and bankroll updated.");
      refreshNightlySession();
    } catch (error) {
      setHistoryMessage(error.message);
    }
  };

  if (!snapshot) {
    return <div className="loading-shell">Loading Ant's props desk...</div>;
  }

  const mobileTabs = [
    { id: "slate", label: "Slate", summary: `${slate.length} games${selectedGame ? ` | ${selectedGame.matchup}` : ""}` },
    { id: "prop", label: "Prop", summary: propForm.player ? `${propForm.player} | ${propForm.stat}` : "Line-check card" },
    { id: "entry", label: "Entry", summary: `${entryPicks.length} leg${entryPicks.length === 1 ? "" : "s"} ready` },
    { id: "queue", label: "Queue", summary: `${snapshot.props?.length || 0} saved | ${snapshot.topProps?.length || 0} top` },
    { id: "journal", label: "Journal", summary: `${snapshot.journal?.length || 0} notes` },
  ];
  const mobilePanelClass = (tab, span) => `panel ${span} mobile-panel ${activeTab === tab ? "active" : ""}`;

  return (
    <div className="app-shell">
      <header className="hero-shell">
        <div className="hero-copy">
          <p className="eyebrow">Ant's NBA Props Desk</p>
          <h1>Decision-first workflow for Sleeper PICKS and PrizePicks.</h1>
          <p>
            The app now runs as a small full-stack setup: live line and injury pulls happen through the backend, manual mode stays fully usable,
            and bankroll discipline still follows the same order every time.
          </p>
        </div>

        <div className="metric-grid">
          {recordSummary?.map((metric) => (
            <MetricCard key={metric.label} label={metric.label} value={metric.value} caption={metric.caption} tone="success" />
          ))}
          <MetricCard
            label="Standard Entries"
            value={`${safeCurrency(snapshot.metrics.sleeperStdEntry)} / ${safeCurrency(snapshot.metrics.prizePicksStdEntry)}`}
            caption="Sleeper / PrizePicks"
          />
        </div>
      </header>

      <section className="hero-rail">
        <div className="hero-rail-card">
          <p className="eyebrow">Session Focus</p>
          <div className="hero-rail-grid">
            <div>
              <span>Preferred date</span>
              <strong>{settingsForm.preferredDate}</strong>
            </div>
            <div>
              <span>Slate range</span>
              <strong>{slateDays} day(s)</strong>
            </div>
            <div>
              <span>Queue board</span>
              <strong>{snapshot.topProps?.length || 0} top plays</strong>
            </div>
            <div>
              <span>Cap guardrail</span>
              <strong>{snapshot.bankroll.maxEntryPct}% max</strong>
            </div>
          </div>
        </div>
      </section>

      {restriction?.message ? <Alert tone={restriction.hardBlock ? "danger" : "warning"}>{restriction.message}</Alert> : null}

      <nav className="mobile-tabbar" aria-label="Primary workspaces">
        {mobileTabs.map((tab) => (
          <button key={tab.id} type="button" className={`mobile-tab ${activeTab === tab.id ? "active" : ""}`} onClick={() => setActiveTab(tab.id)}>
            <strong>{tab.label}</strong>
            <span>{tab.summary}</span>
          </button>
        ))}
      </nav>

      <main className="layout-grid">
        <section className="panel span-12 desktop-panel">
          <SectionHeader
            eyebrow="Nightly Runbook"
            title={nightlySession?.title || "Nightly Session Workflow"}
            body="This keeps the app centered on the actual routine: refresh slate, line-check first, then context, then staking."
            actions={
              <button className="button secondary" onClick={refreshNightlySession}>
                Refresh Session
              </button>
            }
          />
          <div className="session-grid">
            {nightlySession?.steps?.map((step) => (
              <div key={step.label} className={`session-card ${step.done ? "done" : ""}`}>
                <strong>{step.label}</strong>
                <p>{step.detail}</p>
              </div>
            ))}
          </div>
          <p className="session-guardrail">{nightlySession?.guardrail}</p>
        </section>

        <section className={mobilePanelClass("slate", "span-7")}>
          <SectionHeader
            eyebrow="Slate Feed"
            title="Upcoming games and risk context"
            body="Load today plus the next few days so you can research matchups and player pools before the slate locks."
            actions={
              <div className="button-row">
                <label className="slate-days-control">
                  <span>Days</span>
                  <select value={slateDays} onChange={(event) => setSlateDays(event.target.value)}>
                    <option value="1">1</option>
                    <option value="2">2</option>
                    <option value="3">3</option>
                    <option value="4">4</option>
                  </select>
                </label>
                <button className="button primary" onClick={() => loadSlate()} disabled={slateLoading}>
                  {slateLoading ? "Loading Slate..." : "Load Slate"}
                </button>
              </div>
            }
          />

          <div className="mobile-section-summary">
            <span>{slate.length} games loaded</span>
            <span>{selectedGame ? `Focused on ${selectedGame.matchup}` : "Open a game to browse starters and bench rotation"}</span>
          </div>

          {slateMessage ? <Alert tone={slate.length ? "success" : "warning"}>{slateMessage}</Alert> : null}
          {slateWarnings.map((warning) => (
            <Alert key={warning} tone="info">{warning}</Alert>
          ))}

          {Object.entries(groupedSlate).map(([date, games]) => (
            <div key={date} className="slate-day-group">
              <div className="slate-day-header">{date}</div>
              <div className="slate-grid">
                {games.map((game) => (
                  <article className={`slate-card ${selectedGame?.id === game.id ? "active" : ""}`} key={game.id}>
                    <div className="slate-card-top">
                      <div>
                        <h3>{game.matchup}</h3>
                        <p>{formatDateTime(game.start)}</p>
                      </div>
                      <span className="status-pill">{game.postseason ? "Postseason" : "Regular"}</span>
                    </div>
                    <div className="slate-card-metrics">
                      <span>Total {game.consensusTotal ?? "N/A"}</span>
                      <span>Home spread {game.homeSpread ?? "N/A"}</span>
                      <span>{game.injuryCount} injury notes</span>
                    </div>
                    <div className="chip-row">
                      {game.manualOddsCheck ? <span className="chip muted">Manual odds check needed</span> : null}
                      {game.manualInjuryCheck ? <span className="chip muted">Manual injury check needed</span> : null}
                      {game.injuryHighlights.length === 0 ? (
                        <span className="chip muted">No injury highlights returned</span>
                      ) : (
                        game.injuryHighlights.map((injury) => (
                          <span className="chip" key={`${game.id}-${injury.player}`}>
                            {injury.player} {injury.status}
                          </span>
                        ))
                      )}
                    </div>
                    <button className="button secondary full top-gap" onClick={() => loadGameRoster(game)} disabled={gameRosterLoading && selectedGame?.id === game.id}>
                      {gameRosterLoading && selectedGame?.id === game.id ? "Loading Roster..." : "Open Game"}
                    </button>
                  </article>
                ))}
              </div>
            </div>
          ))}

          {selectedGame ? (
            <div className="game-browser top-gap">
              <div className="section-header">
                <div>
                  <p className="eyebrow">Game Browser</p>
                  <h2>{selectedGame.matchup}</h2>
                  <p className="section-copy">{gameRoster?.gameSummary || "Select a player from either team and the app will fill the prop workflow card for you."}</p>
                </div>
              </div>
              {gameRosterMessage ? <Alert tone={gameRoster ? "success" : "warning"}>{gameRosterMessage}</Alert> : null}
              {gameRoster?.sourceNotes ? <Alert tone="info">{gameRoster.sourceNotes}</Alert> : null}
              <div className="roster-grid">
                {[gameRoster?.awayTeam, gameRoster?.homeTeam].filter(Boolean).map((team) => (
                  <div className="roster-card" key={team.name}>
                    <h3>{team.name}</h3>
                    <p className="roster-label">Starters</p>
                    <div className="player-stack">
                      {team.starters.map((player) => (
                        <button className="player-chip" key={`${team.name}-${player}`} onClick={() => chooseGamePlayer(player, team.name)}>
                          {player}
                        </button>
                      ))}
                    </div>
                    <p className="roster-label">Bench</p>
                    <div className="player-stack">
                      {team.bench.map((player) => (
                        <button className="player-chip muted" key={`${team.name}-bench-${player}`} onClick={() => chooseGamePlayer(player, team.name)}>
                          {player}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </section>

        <section className="panel span-5 desktop-panel">
          <SectionHeader
            eyebrow="Feature Status"
            title="Backend and workflow upgrades"
            body="This is the new operating picture so you know what is manual versus live versus AI-assisted."
          />
          <div className="status-stack">
            <MetricCard
              label="Backend API"
              value="Live"
              tone="success"
              caption="OpenAI calls are no longer made from the browser"
            />
            <MetricCard
              label="BallDontLie"
              value={snapshot.capabilities.ballDontLieConfigured ? "Connected" : "Needs Key"}
              tone={snapshot.capabilities.ballDontLieConfigured ? "success" : "warning"}
              caption="Games, injuries, and sharp prop pulls"
            />
            <MetricCard
              label="OpenAI"
              value={snapshot.capabilities.aiEnabled ? "Enabled" : "Optional"}
              tone={snapshot.capabilities.aiEnabled ? "success" : "neutral"}
              caption="Used only for richer analysis after line checking"
            />
            <MetricCard
              label="History"
              value={`${snapshot.entries.length} entries`}
              caption="Stored on the backend JSON state"
            />
          </div>
        </section>

        <section className={mobilePanelClass("prop", "span-8")}>
          <SectionHeader
            eyebrow="Prop Workflow"
            title="Structured line-check card"
            body="This card is built around the required order: line value first, player analysis second, bankroll sizing third."
            actions={
              <div className="button-row">
                <button className="button secondary" onClick={runManualLineCheck}>
                  Manual Line Check
                </button>
                <button className="button secondary" onClick={autofillFromProvider} disabled={providerLoading}>
                  {providerLoading ? "Auto-Filling..." : "Auto-fill From Provider"}
                </button>
                <button className="button secondary" onClick={researchWithAi} disabled={researchLoading}>
                  {researchLoading ? "Researching..." : "Research With AI"}
                </button>
                <button className="button secondary" onClick={saveCurrentProp}>
                  Save To Queue
                </button>
                <button className="button secondary" onClick={addCurrentPropToEntry}>
                  Add To Entry
                </button>
                <button className="button primary" onClick={analyzeProp} disabled={propLoading}>
                  {propLoading ? "Analyzing..." : "Run Full Workflow"}
                </button>
              </div>
            }
          />

          <div className="mobile-section-summary mobile-section-summary-tight">
            <span>{propForm.player || "No player loaded"}</span>
            <span>{propAnalysis ? propAnalysis.finalVerdict : "Set lines, then run the workflow"}</span>
          </div>

          <div className="prop-stage-strip">
            <div className={`prop-stage ${propForm.player ? "complete" : ""}`}>1. Pick player</div>
            <div className={`prop-stage ${(propForm.sleeperLine || propForm.prizePicksLine) ? "complete" : ""}`}>2. Add lines</div>
            <div className={`prop-stage ${(propForm.context || propForm.manualRecentAverage || propForm.manualMinutes) ? "complete" : ""}`}>3. Review context</div>
            <div className={`prop-stage ${propAnalysis ? "complete" : ""}`}>4. Size and decide</div>
          </div>

          {propMessage ? <Alert tone={propAnalysis ? "success" : "warning"}>{propMessage}</Alert> : null}

          <div className="form-grid">
            <label>
              <span>Player</span>
              <input value={propForm.player} onChange={(event) => setPropForm((current) => ({ ...current, player: event.target.value }))} placeholder="Anthony Edwards" />
            </label>
            <label>
              <span>Stat</span>
              <select value={propForm.stat} onChange={(event) => setPropForm((current) => ({ ...current, stat: event.target.value }))}>
                {statOptions.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </label>
            <div className="span-2">
              <span className="inline-label">Stat quick picks</span>
              <StatSelector options={statOptions} value={propForm.stat} onSelect={selectStat} />
            </div>
            <label>
              <span>Date</span>
              <input type="date" value={propForm.date} onChange={(event) => setPropForm((current) => ({ ...current, date: event.target.value }))} />
            </label>
            <label>
              <span>Sleeper line (manual)</span>
              <input value={propForm.sleeperLine} onChange={(event) => updateLineField("sleeperLine", event.target.value)} placeholder="27.5" />
            </label>
            <label>
              <span>PrizePicks line (manual)</span>
              <input value={propForm.prizePicksLine} onChange={(event) => updateLineField("prizePicksLine", event.target.value)} placeholder="28.0" />
            </label>
            <label>
              <span>Sharp consensus line (optional manual)</span>
              <input value={propForm.sharpConsensus} onChange={(event) => updateLineField("sharpConsensus", event.target.value)} placeholder="29.0" />
            </label>
            <label>
              <span>Recent average</span>
              <input value={propForm.manualRecentAverage} onChange={(event) => setPropForm((current) => ({ ...current, manualRecentAverage: event.target.value }))} placeholder="30.2" />
            </label>
            <label>
              <span>Sample size</span>
              <input value={propForm.manualSampleSize} onChange={(event) => setPropForm((current) => ({ ...current, manualSampleSize: event.target.value }))} placeholder="5" />
            </label>
            <label className="span-2">
              <span>Recent game log</span>
              <input value={propForm.manualRecentLog} onChange={(event) => setPropForm((current) => ({ ...current, manualRecentLog: event.target.value }))} placeholder="31, 29, 34, 27, 30" />
            </label>
            <label>
              <span>Expected minutes</span>
              <input value={propForm.manualMinutes} onChange={(event) => setPropForm((current) => ({ ...current, manualMinutes: event.target.value }))} placeholder="37" />
            </label>
            <label>
              <span>Usage change %</span>
              <input value={propForm.manualUsageChange} onChange={(event) => setPropForm((current) => ({ ...current, manualUsageChange: event.target.value }))} placeholder="+4" />
            </label>
            <label>
              <span>Matchup grade</span>
              <select value={propForm.manualMatchupGrade} onChange={(event) => setPropForm((current) => ({ ...current, manualMatchupGrade: event.target.value }))}>
                <option value="neutral">Neutral</option>
                <option value="favorable">Favorable</option>
                <option value="tough">Tough</option>
              </select>
            </label>
            <label className="span-2">
              <span>Injury boost / roster impact</span>
              <input value={propForm.manualInjuryBoost} onChange={(event) => setPropForm((current) => ({ ...current, manualInjuryBoost: event.target.value }))} placeholder="Beal out, so Booker handles more creation." />
            </label>
            <label>
              <span>Pace note</span>
              <input value={propForm.manualPaceNote} onChange={(event) => setPropForm((current) => ({ ...current, manualPaceNote: event.target.value }))} placeholder="Pace-up spot" />
            </label>
            <label>
              <span>Role note</span>
              <input value={propForm.manualRoleNote} onChange={(event) => setPropForm((current) => ({ ...current, manualRoleNote: event.target.value }))} placeholder="Primary scorer in half-court sets" />
            </label>
            <label className="span-2">
              <span>Source notes</span>
              <textarea
                rows="4"
                value={propForm.context}
                onChange={(event) => setPropForm((current) => ({ ...current, context: event.target.value }))}
                placeholder="Where you pulled the lines from, plus matchup, injury, role, or market notes."
              />
            </label>
          </div>

          {propAnalysis ? (
            <div className="workflow-grid">
              <article className="workflow-card">
                <p className="step-label">1. Line Value Check</p>
                <h3>{propAnalysis.lineSummary.leanText}</h3>
                <div className="card-metrics">
                  <span>Verdict {propAnalysis.lineSummary.verdict}</span>
                  <span>Quality {propAnalysis.lineSummary.lineQuality}</span>
                  <span>Gap {propAnalysis.lineSummary.gap ?? "N/A"}</span>
                  <span>Best app {propAnalysis.lineSummary.bestApp}</span>
                </div>
                <div className="chip-row">
                  {propAnalysis.liveContext?.sharpLines?.length ? (
                    propAnalysis.liveContext.sharpLines.map((line) => (
                      <span className="chip" key={line.vendor}>
                        {line.vendor} {line.line}
                      </span>
                    ))
                  ) : (
                    <span className="chip muted">
                      {propForm.sharpConsensus ? `Manual sharp line ${propForm.sharpConsensus}` : "No manual sharp line entered"}
                    </span>
                  )}
                </div>
              </article>

              <article className="workflow-card">
                <p className="step-label">2. Player Analysis</p>
                <h3>Recent average: {propAnalysis.liveContext?.recentGames?.average ?? 0}</h3>
                <p>
                  Sample size: {propAnalysis.liveContext?.recentGames?.sample ?? 0}. Last values: {propAnalysis.liveContext?.recentGames?.lastFive || "Manual mode: no live recent-game pull"}.
                </p>
                <p>{propAnalysis.playerContextSummary}</p>
                <div className="chip-row">
                  {propAnalysis.liveContext?.injuries?.length ? (
                    propAnalysis.liveContext.injuries.map((injury, index) => (
                      <span className="chip" key={`${injury.player}-${index}`}>
                        {injury.player} {injury.status}
                      </span>
                    ))
                  ) : (
                    <span className="chip muted">Manual mode: confirm injuries and minutes yourself</span>
                  )}
                </div>
                {propAnalysis.aiSummary ? <p className="ai-summary">{propAnalysis.aiSummary}</p> : null}
              </article>

              {propAnalysis.researchSkill ? (
                <article className={`workflow-card research-result ${propAnalysis.researchSkill.verdict === "SKIP" ? "warning" : ""}`}>
                  <p className="step-label">{propAnalysis.decisionEngineLabel || "Context-Backed Decision"}</p>
                  <h3>{propAnalysis.researchSkill.uiSummary?.title || `Research Verdict: ${propAnalysis.researchSkill.verdict}`}</h3>
                  <p>{propAnalysis.researchSkill.uiSummary?.why || propAnalysis.researchSkill.decisionExplanation}</p>
                  <div className="chip-row research-chips">
                    <ResearchSignalChip
                      label="Role"
                      value={propAnalysis.researchSkill.scoring?.roleStability || "N/A"}
                      tone={
                        propAnalysis.researchSkill.scoring?.roleStability === "STABLE"
                          ? "success"
                          : propAnalysis.researchSkill.scoring?.roleStability === "FRINGE"
                            ? "warning"
                            : "danger"
                      }
                    />
                    <ResearchSignalChip
                      label="Matchup"
                      value={propAnalysis.researchSkill.scoring?.matchupLean || "N/A"}
                      tone={
                        propAnalysis.researchSkill.scoring?.matchupLean === "FAVORABLE"
                          ? "success"
                          : propAnalysis.researchSkill.scoring?.matchupLean === "NEUTRAL"
                            ? "warning"
                            : "danger"
                      }
                    />
                    <ResearchSignalChip
                      label="Environment"
                      value={propAnalysis.researchSkill.scoring?.environmentLean || "N/A"}
                      tone={
                        propAnalysis.researchSkill.scoring?.environmentLean === "POSITIVE"
                          ? "success"
                          : propAnalysis.researchSkill.scoring?.environmentLean === "NEUTRAL"
                            ? "warning"
                            : "danger"
                      }
                    />
                    <ResearchSignalChip
                      label="Fragility"
                      value={propAnalysis.researchSkill.scoring?.clearancePath || "N/A"}
                      tone={
                        propAnalysis.researchSkill.scoring?.clearancePath === "CLEAR"
                          ? "success"
                          : propAnalysis.researchSkill.scoring?.clearancePath === "NARROW"
                            ? "warning"
                            : "danger"
                      }
                    />
                  </div>
                  <div className="card-metrics">
                    <span>Confidence {propAnalysis.researchSkill.confidence}</span>
                    <span>Range {propAnalysis.researchSkill.uiSummary?.range || propAnalysis.researchSkill.estimatedRange?.label}</span>
                    <span>Score {propAnalysis.researchSkill.scoring?.total ?? "N/A"}</span>
                  </div>
                  <div className="research-columns">
                    <div>
                      <p className="roster-label">Support</p>
                      <ul className="plain-list">
                        {(propAnalysis.researchSkill.uiSummary?.support || propAnalysis.researchSkill.supportFlags || []).map((item) => (
                          <li key={`support-${item}`}>{item}</li>
                        ))}
                      </ul>
                    </div>
                    <div>
                      <p className="roster-label">Risk</p>
                      <ul className="plain-list">
                        {(propAnalysis.researchSkill.uiSummary?.risk || propAnalysis.researchSkill.riskFlags || []).map((item) => (
                          <li key={`risk-${item}`}>{item}</li>
                        ))}
                      </ul>
                    </div>
                  </div>
                </article>
              ) : null}

              <article className="workflow-card">
                <p className="step-label">3. Bankroll Sizing</p>
                <h3>{propAnalysis.bankroll.recommendedPct}% recommendation</h3>
                <div className="card-metrics">
                  <span>Sleeper entry size {safeCurrency(propAnalysis.bankroll.sleeperAmount)}</span>
                  <span>PrizePicks entry size {safeCurrency(propAnalysis.bankroll.prizePicksAmount)}</span>
                  <span>Std entry {safeCurrency(propAnalysis.bankroll.standardSleeper)} / {safeCurrency(propAnalysis.bankroll.standardPrizePicks)}</span>
                  <span>Entry cap {safeCurrency(propAnalysis.bankroll.maxSleeper)} / {safeCurrency(propAnalysis.bankroll.maxPrizePicks)}</span>
                </div>
                <ul className="plain-list">
                  {propAnalysis.checklist.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </article>

              <article className="workflow-card final">
                <p className="step-label">4. Final Decision</p>
                <h3>{propAnalysis.finalVerdict}</h3>
                <p>Confidence: {propAnalysis.confidence}. Research confidence: {propAnalysis.researchConfidence}.</p>
                <ul className="plain-list">
                  {propAnalysis.preLockChecklist?.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
                {propAnalysis.chasingFlag ? <Alert tone="danger">Chasing behavior detected. Do not submit this entry.</Alert> : null}
              </article>
            </div>
          ) : null}

          <div className="line-history top-gap">
            <p className="roster-label">Line Timestamps</p>
            <div className="chip-row">
              <span className="chip muted">Sleeper {propForm.lineTimestamps.sleeperLine ? formatDateTime(propForm.lineTimestamps.sleeperLine) : "not set"}</span>
              <span className="chip muted">PrizePicks {propForm.lineTimestamps.prizePicksLine ? formatDateTime(propForm.lineTimestamps.prizePicksLine) : "not set"}</span>
              <span className="chip muted">Sharp {propForm.lineTimestamps.sharpConsensus ? formatDateTime(propForm.lineTimestamps.sharpConsensus) : "not set"}</span>
            </div>
          </div>
        </section>

        <section className={mobilePanelClass("entry", "span-4")}>
          <SectionHeader
            eyebrow="Entry Builder"
            title="One-ticket review"
            body="Use this after each leg has already passed the line-check stage."
            actions={
              <button className="button primary" onClick={analyzeEntry} disabled={entryLoading || entryPicks.length < 2}>
                {entryLoading ? "Reviewing..." : "Analyze Entry"}
              </button>
            }
          />

          <div className="mobile-section-summary mobile-section-summary-tight">
            <span>{entryPicks.length}/3 legs</span>
            <span>{entryPicks[0]?.app || entryForm.app}</span>
          </div>

          {entryMessage ? <Alert tone={entryAnalysis ? "success" : "warning"}>{entryMessage}</Alert> : null}

          <div className="form-grid compact">
            <label>
              <span>Player</span>
              <input value={entryForm.player} onChange={(event) => setEntryForm((current) => ({ ...current, player: event.target.value }))} />
            </label>
            <label>
              <span>Stat</span>
              <input value={entryForm.stat} onChange={(event) => setEntryForm((current) => ({ ...current, stat: event.target.value }))} placeholder="Points" />
            </label>
            <label>
              <span>Lean</span>
              <select value={entryForm.lean} onChange={(event) => setEntryForm((current) => ({ ...current, lean: event.target.value }))}>
                <option>MORE</option>
                <option>LESS</option>
              </select>
            </label>
            <label>
              <span>Platform</span>
              <select value={entryForm.app} onChange={(event) => setEntryForm((current) => ({ ...current, app: event.target.value }))}>
                <option>Sleeper</option>
                <option>PrizePicks</option>
              </select>
            </label>
            <label>
              <span>Team tag</span>
              <input value={entryForm.team} onChange={(event) => setEntryForm((current) => ({ ...current, team: event.target.value }))} placeholder="MIN" />
            </label>
          </div>

          <button className="button secondary full" onClick={addEntryPick}>
            Add Pick
          </button>

          <div className="ticket-stack">
            {entryPicks.map((pick, index) => (
              <div className="ticket-leg" key={`${pick.player}-${index}`}>
                <div>
                  <strong>{pick.player}</strong>
                  <p>
                    {pick.stat} - {pick.lean} - {pick.app}
                  </p>
                </div>
                <button
                  className="link-button"
                  onClick={() => setEntryPicks((current) => current.filter((_, pickIndex) => pickIndex !== index))}
                >
                  Remove
                </button>
              </div>
            ))}
          </div>

          {entryAnalysis ? (
            <div className="entry-review">
              <h3>{entryAnalysis.action}</h3>
              <p>Confidence: {entryAnalysis.confidence}</p>
              <p>
                Standard size {safeCurrency(entryAnalysis.standardSize)}. Hard cap {safeCurrency(entryAnalysis.maxSize)}.
              </p>
              <ul className="plain-list">
                {entryAnalysis.guidance.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
              {entryAnalysis.aiSummary ? <p className="ai-summary">{entryAnalysis.aiSummary}</p> : null}
            </div>
          ) : null}
        </section>

        <section className={mobilePanelClass("queue", "span-6")}>
          <SectionHeader eyebrow="Bankroll and History" title="Persistent bankroll state" body="Updates here are stored by the backend, not just in browser memory." />
          <div className="mobile-section-summary">
            <span>{safeCurrency(snapshot.bankroll.sleeper + snapshot.bankroll.prizepicks)} total bankroll</span>
            <span>{snapshot.entries.length} logged entries</span>
          </div>
          {historyMessage ? <Alert tone="info">{historyMessage}</Alert> : null}
          <div className="bankroll-grid">
            <div className="bankroll-card">
              <h3>Sleeper</h3>
              <p>{safeCurrency(snapshot.bankroll.sleeper)}</p>
              <div className="inline-form">
                <input value={bankrollInputs.sleeper} onChange={(event) => setBankrollInputs((current) => ({ ...current, sleeper: event.target.value }))} />
                <button className="button secondary" onClick={() => updateBankroll("Sleeper")}>
                  Set
                </button>
              </div>
            </div>
            <div className="bankroll-card">
              <h3>PrizePicks</h3>
              <p>{safeCurrency(snapshot.bankroll.prizepicks)}</p>
              <div className="inline-form">
                <input value={bankrollInputs.prizepicks} onChange={(event) => setBankrollInputs((current) => ({ ...current, prizepicks: event.target.value }))} />
                <button className="button secondary" onClick={() => updateBankroll("PrizePicks")}>
                  Set
                </button>
              </div>
            </div>
          </div>

          <div className="form-grid compact top-gap">
            <label>
              <span>Platform</span>
              <select value={logForm.platform} onChange={(event) => setLogForm((current) => ({ ...current, platform: event.target.value }))}>
                <option>Sleeper</option>
                <option>PrizePicks</option>
              </select>
            </label>
            <label className="span-2">
              <span>Picks</span>
              <input value={logForm.picks} onChange={(event) => setLogForm((current) => ({ ...current, picks: event.target.value }))} placeholder="Ant points MORE / Gobert rebounds LESS" />
            </label>
            <label>
              <span>Entry</span>
              <input value={logForm.entry} onChange={(event) => setLogForm((current) => ({ ...current, entry: event.target.value }))} />
            </label>
            <label>
              <span>Result</span>
              <select value={logForm.result} onChange={(event) => setLogForm((current) => ({ ...current, result: event.target.value }))}>
                <option>WIN</option>
                <option>LOSS</option>
              </select>
            </label>
            <label>
              <span>Payout</span>
              <input value={logForm.payout} onChange={(event) => setLogForm((current) => ({ ...current, payout: event.target.value }))} />
            </label>
          </div>

          <button className="button primary full top-gap" onClick={logEntry}>
            Log Entry
          </button>

          <div className="history-table top-gap">
            <div className="history-row header">
              <span>Date</span>
              <span>Platform</span>
              <span>Picks</span>
              <span>P&L</span>
            </div>
            {snapshot.entries.slice(0, 12).map((entry, index) => (
              <div className="history-row" key={`${entry.timestamp}-${index}`}>
                <span>{entry.date}</span>
                <span>{entry.platform}</span>
                <span>{entry.picks}</span>
                <span className={entry.pnl >= 0 ? "profit" : "loss"}>{entry.pnl >= 0 ? "+" : "-"}{safeCurrency(Math.abs(entry.pnl))}</span>
              </div>
            ))}
          </div>
        </section>

        <section className={mobilePanelClass("queue", "span-6")}>
          <SectionHeader eyebrow="Best Plays" title="Prop queue and watchlist" body="Saved props are bucketed so you can keep a board of playable looks, watch items, missing-line spots, and skips." />
          <div className="mobile-section-summary">
            <span>{snapshot.props?.length || 0} saved props</span>
            <span>{snapshot.topProps?.length || 0} on the board</span>
          </div>
          <div className="queue-columns">
            {["playable", "watch", "need-line", "skip"].map((bucket) => (
              <div className="queue-column" key={bucket}>
                <p className="roster-label">{bucket}</p>
                <div className="queue-stack">
                  {(snapshot.props || []).filter((prop) => prop.bucket === bucket).slice(0, 8).map((prop) => (
                    <button
                      type="button"
                      className="queue-card"
                      key={prop.id}
                      onClick={() => {
                        setPropForm((current) => ({ ...current, ...initialPropForm, ...prop }));
                        setActiveTab("prop");
                      }}
                    >
                      <strong>{prop.player}</strong>
                      <span>{prop.stat} • {prop.finalVerdict || "ANALYZE"}</span>
                      <span>{prop.lineSummary?.lineQuality || "UNKNOWN"} • score {prop.bestPlayScore ?? 0}</span>
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
          <div className="top-gap">
            <p className="roster-label">Best plays board</p>
            <div className="queue-stack">
              {(snapshot.topProps || []).map((prop) => (
                <div className="queue-card static" key={`top-${prop.id}`}>
                  <strong>{prop.player} - {prop.stat}</strong>
                  <span>{prop.finalVerdict || "ANALYZE"} • {prop.lineSummary?.bestApp || "Manual"} • research {prop.researchConfidence || "low"}</span>
                  <span>Sleeper {prop.sleeperLine || "-"} / PrizePicks {prop.prizePicksLine || "-"} / Sharp {prop.sharpConsensus || "-"}</span>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className={mobilePanelClass("journal", "span-6")}>
          <SectionHeader eyebrow="Daily Journal" title="Notes and recap" body="Save what you liked, what you played, and what you want to remember for the next slate." />
          <div className="mobile-section-summary">
            <span>{snapshot.journal?.length || 0} saved notes</span>
            <span>{settingsForm.notes ? "Nightly notes are active in settings" : "Use settings for a standing reminder"}</span>
          </div>
          <div className="form-grid">
            <label>
              <span>Journal title</span>
              <input value={journalTitle} onChange={(event) => setJournalTitle(event.target.value)} placeholder="Friday slate notes" />
            </label>
            <label className="span-2">
              <span>Journal note</span>
              <textarea rows="4" value={journalBody} onChange={(event) => setJournalBody(event.target.value)} placeholder="What stood out, which edges were real, and what to watch later." />
            </label>
          </div>
          <button className="button primary top-gap" onClick={saveJournalEntry}>
            Save Journal Note
          </button>
          <div className="queue-stack top-gap">
            {(snapshot.journal || []).slice(0, 8).map((entry) => (
              <div className="queue-card static" key={entry.id}>
                <strong>{entry.title}</strong>
                <span>{entry.date}</span>
                <span>{entry.body}</span>
              </div>
            ))}
          </div>
        </section>

        <section className={mobilePanelClass("journal", "span-6")}>
          <SectionHeader eyebrow="Settings and Deployment" title="Backend-backed settings" body="These keys now live on the server side for local use, and the `.env.example` file is ready for deployment configuration." />
          {settingsMessage ? <Alert tone="info">{settingsMessage}</Alert> : null}
          <div className="form-grid">
            <label>
              <span>OpenAI API key</span>
              <input type="password" value={settingsForm.openaiApiKey} onChange={(event) => setSettingsForm((current) => ({ ...current, openaiApiKey: event.target.value }))} placeholder="Optional for richer analysis" />
            </label>
            <label>
              <span>BallDontLie API key</span>
              <input type="password" value={settingsForm.ballDontLieApiKey} onChange={(event) => setSettingsForm((current) => ({ ...current, ballDontLieApiKey: event.target.value }))} placeholder="Needed for games, injuries, and sharp lines" />
            </label>
            <label>
              <span>Odds provider</span>
              <select value={settingsForm.oddsProvider} onChange={(event) => setSettingsForm((current) => ({ ...current, oddsProvider: event.target.value }))}>
                <option value="manual">Manual only</option>
                <option value="the-odds-api">The Odds API</option>
              </select>
            </label>
            <label>
              <span>Odds provider API key</span>
              <input type="password" value={settingsForm.oddsApiKey} onChange={(event) => setSettingsForm((current) => ({ ...current, oddsApiKey: event.target.value }))} placeholder="Optional for provider auto-fill" />
            </label>
            <label>
              <span>Preferred date</span>
              <input type="date" value={settingsForm.preferredDate} onChange={(event) => setSettingsForm((current) => ({ ...current, preferredDate: event.target.value }))} />
            </label>
            <label>
              <span>Standard entry %</span>
              <input type="number" min="1" max="20" value={settingsForm.entryPct} onChange={(event) => setSettingsForm((current) => ({ ...current, entryPct: event.target.value }))} />
            </label>
            <label>
              <span>Max entry %</span>
              <input type="number" min="1" max="20" value={settingsForm.maxEntryPct} onChange={(event) => setSettingsForm((current) => ({ ...current, maxEntryPct: event.target.value }))} />
            </label>
            <label className="toggle">
              <span>Enable AI analysis after line check</span>
              <input type="checkbox" checked={settingsForm.aiAnalysisEnabled} onChange={(event) => setSettingsForm((current) => ({ ...current, aiAnalysisEnabled: event.target.checked }))} />
            </label>
            <label className="toggle">
              <span>Auto-load slate on app start</span>
              <input type="checkbox" checked={settingsForm.autoLoadSlate} onChange={(event) => setSettingsForm((current) => ({ ...current, autoLoadSlate: event.target.checked }))} />
            </label>
            <label className="span-2">
              <span>Nightly notes</span>
              <textarea rows="4" value={settingsForm.notes} onChange={(event) => setSettingsForm((current) => ({ ...current, notes: event.target.value }))} placeholder="Session reminders, withdrawal rules, or matchup ideas." />
            </label>
          </div>
          <button className="button primary top-gap" onClick={saveSettings}>
            Save Settings
          </button>
          <div className="deployment-note top-gap">
            <strong>Deployment prep</strong>
            <p>
              The frontend now talks to `/api` instead of OpenAI directly, Vite proxies local development to the backend, and the server can serve the built app for a simple single-host deployment.
            </p>
          </div>
        </section>
      </main>
    </div>
  );
}
