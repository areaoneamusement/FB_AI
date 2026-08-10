import type {
  ScoreBreakdown,
  Topic,
  TopicScore,
} from "../domain/content.js";

export interface ScoringCriterion {
  readonly id: string;
  readonly weightPercent: number;
}

export interface ScoringConfig {
  readonly version: string;
  readonly criteria: readonly ScoringCriterion[];
}

export type CriterionValues = Readonly<Record<string, number | undefined>>;

const WEIGHT_TOTAL = 100;
const WEIGHT_TOLERANCE = 1e-9;

function assertBoundedNumber(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    throw new RangeError(`${label} must be a finite number in [0, 100]`);
  }
}

function freezeScore(score: TopicScore): TopicScore {
  return Object.freeze({
    ...score,
    breakdown: Object.freeze([...score.breakdown]),
  });
}

/** Deterministic, side-effect-free topic scoring and selection. */
export class TopicScorer {
  readonly #criteria: readonly ScoringCriterion[];
  readonly #configVersion: string;

  constructor(config: ScoringConfig) {
    if (config.version.trim().length === 0) {
      throw new Error("Scoring config version must not be empty");
    }
    if (config.criteria.length === 0) {
      throw new Error("Scoring config must contain at least one criterion");
    }

    const ids = new Set<string>();
    let weightTotal = 0;
    this.#criteria = Object.freeze(
      config.criteria.map((criterion) => {
        if (criterion.id.trim().length === 0) {
          throw new Error("Scoring criterion id must not be empty");
        }
        if (ids.has(criterion.id)) {
          throw new Error(`Duplicate scoring criterion: ${criterion.id}`);
        }
        assertBoundedNumber(
          criterion.weightPercent,
          `Weight for criterion ${criterion.id}`,
        );
        ids.add(criterion.id);
        weightTotal += criterion.weightPercent;
        return Object.freeze({ ...criterion });
      }),
    );

    if (Math.abs(weightTotal - WEIGHT_TOTAL) > WEIGHT_TOLERANCE) {
      throw new Error("Scoring criterion weights must total 100 percent");
    }
    this.#configVersion = config.version;
  }

  score(topic: Topic, values: CriterionValues): Topic {
    const breakdown: ScoreBreakdown[] = [];
    const missingCriterionIds: string[] = [];

    for (const criterion of this.#criteria) {
      const componentValue = values[criterion.id];
      if (componentValue === undefined || componentValue === null) {
        missingCriterionIds.push(criterion.id);
        continue;
      }
      assertBoundedNumber(
        componentValue,
        `Component value for criterion ${criterion.id}`,
      );
      breakdown.push(
        Object.freeze({
          criterionId: criterion.id,
          componentValue,
          weightPercent: criterion.weightPercent,
        }),
      );
    }

    if (missingCriterionIds.length > 0) {
      return Object.freeze({
        ...topic,
        score: freezeScore({
          total: null,
          breakdown,
          scoringConfigVersion: this.#configVersion,
          unscoredReason: `Missing scoring input for criteria: ${missingCriterionIds.join(", ")}`,
        }),
      });
    }

    const weightedSum = breakdown.reduce(
      (sum, item) => sum + item.componentValue * item.weightPercent,
      0,
    );
    const total = Math.min(100, Math.max(0, weightedSum / WEIGHT_TOTAL));

    return Object.freeze({
      ...topic,
      score: freezeScore({
        total,
        breakdown,
        scoringConfigVersion: this.#configVersion,
      }),
    });
  }

  rank(topics: readonly Topic[]): readonly Topic[] {
    return Object.freeze(
      [...topics].sort((left, right) => {
        const leftScore = left.score.total;
        const rightScore = right.score.total;
        if (leftScore === null && rightScore !== null) return 1;
        if (leftScore !== null && rightScore === null) return -1;
        if (leftScore !== null && rightScore !== null && leftScore !== rightScore) {
          return rightScore - leftScore;
        }
        return Date.parse(right.createdAt) - Date.parse(left.createdAt);
      }),
    );
  }

  advance(topics: readonly Topic[], minScore: number): readonly Topic[] {
    assertBoundedNumber(minScore, "Minimum score");
    return Object.freeze(
      topics.filter(
        (topic) =>
          topic.score.total !== null &&
          Number.isFinite(topic.score.total) &&
          topic.score.total >= minScore,
      ),
    );
  }
}
