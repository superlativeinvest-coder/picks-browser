const normalizeConfidenceFromScore = (score) => {
  if (score >= 75) return "HIGH";
  if (score >= 60) return "MEDIUM";
  return "LOW";
};

const normalizeVerdictFromSignals = ({
  total,
  roleStability,
  clearancePath,
  matchupLean,
  supportFlags,
  riskFlags,
}) => {
  const supportCount = supportFlags.length;
  const riskCount = riskFlags.length;

  if (roleStability === "VOLATILE") return "SKIP";
  if (total < 60) return "SKIP";
  if (riskCount >= supportCount + 2) return "SKIP";

  if (clearancePath === "CLEAR" && matchupLean !== "TOUGH" && supportCount >= riskCount) {
    return "MORE";
  }

  if ((clearancePath === "FRAGILE" || matchupLean === "TOUGH") && riskCount >= supportCount) {
    return "LESS";
  }

  return "SKIP";
};

export const normalizeResearchVerdict = (result) => {
  const normalizationNotes = [];
  const nextResult = structuredClone(result);

  nextResult.supportFlags = nextResult.supportFlags.filter(Boolean).slice(0, 8);
  nextResult.riskFlags = nextResult.riskFlags.filter(Boolean).slice(0, 8);

  if (nextResult.estimatedRange.high < nextResult.estimatedRange.low) {
    const originalLow = nextResult.estimatedRange.low;
    nextResult.estimatedRange.low = nextResult.estimatedRange.high;
    nextResult.estimatedRange.high = originalLow;
    normalizationNotes.push("Swapped invalid estimated range bounds.");
  }

  nextResult.estimatedRange.label = `${nextResult.estimatedRange.low}-${nextResult.estimatedRange.high}`;
  nextResult.uiSummary.range = nextResult.estimatedRange.label;

  const computedConfidence = normalizeConfidenceFromScore(nextResult.scoring.total);
  if (nextResult.confidence !== computedConfidence) {
    nextResult.confidence = computedConfidence;
    normalizationNotes.push("Confidence aligned to deterministic score thresholds.");
  }

  if (nextResult.scoring.roleStability === "VOLATILE") {
    if (nextResult.verdict !== "SKIP") {
      nextResult.verdict = "SKIP";
      normalizationNotes.push("Role volatility forced verdict to SKIP.");
    }
    if (!nextResult.riskFlags.some((flag) => /role uncertainty|rotation risk/i.test(flag))) {
      nextResult.riskFlags.unshift("High role uncertainty / rotation risk.");
    }
  }

  if (nextResult.scoring.total < 60 && nextResult.verdict !== "SKIP") {
    nextResult.verdict = "SKIP";
    normalizationNotes.push("Total score below 60 forced verdict to SKIP.");
  }

  const normalizedVerdict = normalizeVerdictFromSignals({
    total: nextResult.scoring.total,
    roleStability: nextResult.scoring.roleStability,
    clearancePath: nextResult.scoring.clearancePath,
    matchupLean: nextResult.scoring.matchupLean,
    supportFlags: nextResult.supportFlags,
    riskFlags: nextResult.riskFlags,
  });

  if (normalizedVerdict !== nextResult.verdict) {
    nextResult.verdict = normalizedVerdict;
    normalizationNotes.push("Verdict adjusted to deterministic guardrails.");
  }

  nextResult.uiSummary.title = `Research Verdict: ${nextResult.verdict}`;
  nextResult.uiSummary.why = nextResult.decisionExplanation;
  nextResult.uiSummary.support = nextResult.supportFlags.slice(0, 5);
  nextResult.uiSummary.risk = nextResult.riskFlags.slice(0, 5);

  return {
    result: nextResult,
    normalizationNotes,
  };
};
