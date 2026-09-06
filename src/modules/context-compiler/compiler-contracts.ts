export const CONTEXT_COMPILE_SECTION_RATIOS = {
  rules: 0.55,
  procedures: 0.45,
  guardrails: 0.3,
} as const;

export const CONTEXT_COMPILE_LIMITS = {
  vectorOnlyScoreFloor: 0.52,
  normalRankingLimit: 15,
  episodePrecedentLimit: 2,
} as const;
