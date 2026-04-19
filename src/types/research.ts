export type ResearchStat = "PTS" | "REB" | "AST" | "PRA" | "PR" | "PA" | "RA";

export type StartingStatus = "CONFIRMED" | "LIKELY" | "UNCERTAIN";

export type RoleTag = "PRIMARY" | "SECONDARY" | "BENCH";

export type ResearchVerdict = "MORE" | "LESS" | "SKIP";

export type ResearchConfidence = "LOW" | "MEDIUM" | "HIGH";

export type RoleStability = "STABLE" | "FRINGE" | "VOLATILE";

export type EnvironmentLean = "POSITIVE" | "NEUTRAL" | "NEGATIVE";

export type MatchupLean = "FAVORABLE" | "NEUTRAL" | "TOUGH";

export type ClearancePath = "CLEAR" | "NARROW" | "FRAGILE";

export type ResearchInput = {
  player: string;
  team: string;
  opponent: string;
  stat: ResearchStat;
  line: number;
  isHome: boolean;
  spread?: number;
  total?: number;
  backToBack?: boolean;
  startingStatus?: StartingStatus;
  expectedMinutes?: string;
  roleTag?: RoleTag;
  teammateImpact?: string[];
  injuryNotes?: string[];
  rotationNotes?: string[];
  matchupNotes?: string[];
};

export type ResearchEstimatedRange = {
  low: number;
  high: number;
  label: string;
};

export type ResearchScoring = {
  role: number;
  environment: number;
  matchup: number;
  support: number;
  riskPenalty: number;
  total: number;
  roleStability: RoleStability;
  environmentLean: EnvironmentLean;
  matchupLean: MatchupLean;
  clearancePath: ClearancePath;
};

export type ResearchUiSummary = {
  title: string;
  why: string;
  support: string[];
  risk: string[];
  range: string;
};

export type ResearchOutput = {
  verdict: ResearchVerdict;
  confidence: ResearchConfidence;
  propSummary: string;
  roleContext: string;
  gameContext: string;
  matchupContext: string;
  supportFlags: string[];
  riskFlags: string[];
  estimatedRange: ResearchEstimatedRange;
  scoring: ResearchScoring;
  decisionExplanation: string;
  uiSummary: ResearchUiSummary;
};

export type NormalizedResearchResult = {
  result: ResearchOutput;
  normalizationNotes: string[];
};

export type RunNbaPropResearchSkillOptions = {
  apiKey?: string;
  client?: {
    responses: {
      create: (payload: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };
  };
  model?: string;
};
