import fc from "fast-check";
import { describe, expect, it } from "vitest";

import type { Topic, TopicScore } from "../src/domain/content.js";
import {
  TopicScorer,
  type CriterionValues,
  type ScoringConfig,
} from "../src/pipeline/topic-scorer.js";

/**
 * Property tests for Topic_Scorer (Requirement 2).
 *
 * Every property runs at least 100 generated cases. Numeric assertions are
 * exact: the scorer is a deterministic double-precision computation, so the
 * expected value is reproduced with the same arithmetic instead of being
 * compared with a tolerance.
 */
const RUNS = { numRuns: 300 } as const;

const MAX_CRITERIA = 5;

/** Vietnamese / non-ASCII / empty / whitespace titles plus generated unicode. */
const titleArb = fc.oneof(
  fc.constantFrom(
    "Cập nhật công cụ AI",
    "Kỹ năng AI cho người mới",
    "Mô hình ngôn ngữ lớn – bản cập nhật",
    "日本語のタイトル",
    "Тема ИИ",
    "🚀 AI agent",
    "",
    "   ",
  ),
  fc.string({ unit: "grapheme" }),
);

/** Timestamps drawn from a small pool so createdAt ties occur often. */
const TIE_TIMES = [
  "2024-01-01T00:00:00.000Z",
  "2025-01-01T00:00:00.000Z",
  "2025-01-01T00:00:00.001Z",
  "2025-06-15T12:30:00.000Z",
] as const;

const createdAtArb = fc.oneof(
  { weight: 3, arbitrary: fc.constantFrom(...TIE_TIMES) },
  {
    weight: 1,
    arbitrary: fc
      .integer({ min: Date.UTC(2020, 0, 1), max: Date.UTC(2030, 0, 1) })
      .map((ms) => new Date(ms).toISOString()),
  },
);

/** Component values: integers in [0,100] including both boundaries. */
const componentArb = fc.integer({ min: 0, max: 100 });

function criterionIds(count: number): readonly string[] {
  return Array.from({ length: count }, (_, index) => `criterion-${index}`);
}

/**
 * Dyadic weights: multiples of 0.25 summing to exactly 100.
 *
 * Integer quarter-parts are normalised to sum to 400 so the weights are exact
 * binary fractions. With integer components this makes every product and every
 * partial sum exactly representable, which lets the expected total be derived
 * from exact integer arithmetic (see `exactTotal`).
 */
const quarterPartsArb = (count: number) =>
  fc
    .array(fc.integer({ min: 0, max: 400 }), {
      minLength: count,
      maxLength: count,
    })
    .map((raw) => {
      const sum = raw.reduce((total, value) => total + value, 0);
      if (sum === 0) {
        const parts = new Array<number>(count).fill(0);
        parts[count - 1] = 400;
        return parts;
      }
      const parts = raw.map((value) => Math.floor((value * 400) / sum));
      const assigned = parts.reduce((total, value) => total + value, 0);
      parts[count - 1] += 400 - assigned;
      return parts;
    });

/**
 * Floating-point weight combinations (e.g. 33.33 / 33.33 / 33.34) that satisfy
 * the "weights total 100" contract only up to the scorer's 1e-9 tolerance.
 */
const floatWeightsArb = (count: number) =>
  fc
    .array(fc.integer({ min: 1, max: 100_000 }), {
      minLength: count,
      maxLength: count,
    })
    .map((raw) => {
      const sum = raw.reduce((total, value) => total + value, 0);
      const weights = raw
        .slice(0, count - 1)
        .map((value) => (value * 100) / sum);
      const assigned = weights.reduce((total, value) => total + value, 0);
      weights.push(Math.max(0, 100 - assigned));
      return weights;
    });

interface ScoringCase {
  readonly config: ScoringConfig;
  readonly values: CriterionValues;
  readonly components: readonly number[];
  readonly quarterParts?: readonly number[];
  readonly title: string;
  readonly createdAt: string;
}

const scoringCaseArb = (
  weightsFor: (count: number) => fc.Arbitrary<number[]>,
  exact: boolean,
) =>
  fc
    .integer({ min: 1, max: MAX_CRITERIA })
    .chain((count) =>
      fc.record({
        count: fc.constant(count),
        weights: weightsFor(count),
        components: fc.array(componentArb, {
          minLength: count,
          maxLength: count,
        }),
        title: titleArb,
        createdAt: createdAtArb,
        version: fc.constantFrom("score-v1", "score-v2.1"),
      }),
    )
    .map(({ count, weights, components, title, createdAt, version }): ScoringCase => {
      const ids = criterionIds(count);
      const weightPercents = exact
        ? weights.map((part) => part / 4)
        : weights;
      const values: Record<string, number> = {};
      ids.forEach((id, index) => {
        values[id] = components[index]!;
      });
      return {
        config: {
          version,
          criteria: ids.map((id, index) => ({
            id,
            weightPercent: weightPercents[index]!,
          })),
        },
        values,
        components,
        ...(exact ? { quarterParts: weights } : {}),
        title,
        createdAt,
      };
    });

function topicOf(
  id: string,
  createdAt: string,
  title: string,
  score: TopicScore,
): Topic {
  return {
    id,
    externalId: `external-${id}`,
    title,
    createdAt,
    score,
    categories: ["AI"],
    sourceRef: {
      sourceId: "source-1",
      captureId: `capture-${id}`,
      url: `https://example.test/${encodeURIComponent(id)}`,
      capturedAt: "2025-01-01T00:00:00.000Z",
      termsVersion: "terms-v1",
    },
  };
}

const UNSCORED: TopicScore = {
  total: null,
  breakdown: [],
  scoringConfigVersion: "pending",
  unscoredReason: "Not scored yet",
};

/**
 * Exact expected total for integer components and quarter-multiple weights.
 * `sum(component * weight)` is computed in integer space (quarter units) so it
 * carries no rounding, leaving the single division by 100 as the only rounded
 * operation - exactly as the implementation performs it.
 */
function exactTotal(
  components: readonly number[],
  quarterParts: readonly number[],
): number {
  const quarterSum = components.reduce(
    (total, component, index) => total + component * quarterParts[index]!,
    0,
  );
  return Math.min(100, Math.max(0, quarterSum / 400));
}

describe("TopicScorer properties", () => {
  // Feature: fb-ai, Property 7: Score is the bounded weighted sum of components
  it("Property 7: score is the bounded weighted sum of components (exact weights)", () => {
    fc.assert(
      fc.property(scoringCaseArb(quarterPartsArb, true), (testCase) => {
        const scorer = new TopicScorer(testCase.config);
        const topic = topicOf(
          "scored",
          testCase.createdAt,
          testCase.title,
          UNSCORED,
        );
        const result = scorer.score(topic, testCase.values);
        const { total, breakdown } = result.score;

        // Each configured criterion is persisted exactly once, in order.
        expect(breakdown.map((item) => item.criterionId)).toEqual(
          testCase.config.criteria.map((criterion) => criterion.id),
        );
        expect(result.score.scoringConfigVersion).toBe(testCase.config.version);

        // Components are bounded and the weights total 100 percent.
        for (const item of breakdown) {
          expect(item.componentValue).toBeGreaterThanOrEqual(0);
          expect(item.componentValue).toBeLessThanOrEqual(100);
          expect(item.weightPercent).toBeGreaterThanOrEqual(0);
          expect(item.weightPercent).toBeLessThanOrEqual(100);
        }
        expect(
          breakdown.reduce((sum, item) => sum + item.weightPercent, 0),
        ).toBe(100);

        // The total is bounded and exactly the weighted sum.
        expect(total).not.toBeNull();
        expect(total!).toBeGreaterThanOrEqual(0);
        expect(total!).toBeLessThanOrEqual(100);
        expect(total).toBe(
          exactTotal(testCase.components, testCase.quarterParts!),
        );

        // The persisted breakdown reproduces the persisted total.
        expect(total).toBe(
          Math.min(
            100,
            Math.max(
              0,
              breakdown.reduce(
                (sum, item) => sum + item.componentValue * item.weightPercent,
                0,
              ) / 100,
            ),
          ),
        );

        // Scoring is deterministic and does not mutate its input.
        expect(scorer.score(topic, testCase.values).score).toEqual(result.score);
        expect(topic.score.total).toBeNull();
      }),
      RUNS,
    );
  });

  // Feature: fb-ai, Property 7: Score is the bounded weighted sum of components
  it("Property 7: score is the bounded weighted sum of components (floating-point weights)", () => {
    fc.assert(
      fc.property(scoringCaseArb(floatWeightsArb, false), (testCase) => {
        const scorer = new TopicScorer(testCase.config);
        const topic = topicOf(
          "scored-float",
          testCase.createdAt,
          testCase.title,
          UNSCORED,
        );
        const result = scorer.score(topic, testCase.values);
        const { total, breakdown } = result.score;

        expect(breakdown).toHaveLength(testCase.config.criteria.length);
        // Weights only need to total 100 within the scorer's declared 1e-9
        // tolerance: 33.33 + 33.33 + 33.34 is not exactly 100 in binary
        // floating point. The total itself is still asserted exactly below.
        expect(
          Math.abs(
            breakdown.reduce((sum, item) => sum + item.weightPercent, 0) - 100,
          ),
        ).toBeLessThanOrEqual(1e-9);

        expect(total).not.toBeNull();
        expect(total!).toBeGreaterThanOrEqual(0);
        expect(total!).toBeLessThanOrEqual(100);

        // The persisted breakdown reproduces the persisted total exactly,
        // using the same accumulation order as the scorer.
        expect(total).toBe(
          Math.min(
            100,
            Math.max(
              0,
              breakdown.reduce(
                (sum, item) => sum + item.componentValue * item.weightPercent,
                0,
              ) / 100,
            ),
          ),
        );

        expect(scorer.score(topic, testCase.values).score.total).toBe(total);
      }),
      RUNS,
    );
  });

  // Feature: fb-ai, Property 8: Topics are ranked by descending score with newer-first tie-break
  it("Property 8: topics are ranked by descending score with newer-created-first tie-break", () => {
    const scorePoolArb = fc.oneof(
      fc.constantFrom<number | null>(0, 50, 99.9, 100, null),
      fc.double({ min: 0, max: 100, noNaN: true }),
    );
    const rankableArb = fc.array(
      fc.record({
        score: scorePoolArb,
        createdAt: createdAtArb,
        title: titleArb,
      }),
      { minLength: 0, maxLength: 8 },
    );

    fc.assert(
      fc.property(rankableArb, (entries) => {
        const scorer = new TopicScorer({
          version: "score-v1",
          criteria: [{ id: "only", weightPercent: 100 }],
        });
        const topics = entries.map((entry, index) =>
          topicOf(
            `topic-${index}`,
            entry.createdAt,
            entry.title,
            entry.score === null
              ? UNSCORED
              : {
                  total: entry.score,
                  breakdown: [],
                  scoringConfigVersion: "score-v1",
                },
          ),
        );
        const inputOrder = topics.map((topic) => topic.id);
        const ranked = scorer.rank(topics);

        // Ranking is a permutation that leaves the input untouched.
        expect([...ranked].map((topic) => topic.id).sort()).toEqual(
          [...inputOrder].sort(),
        );
        expect(topics.map((topic) => topic.id)).toEqual(inputOrder);

        for (let index = 1; index < ranked.length; index += 1) {
          const previous = ranked[index - 1]!;
          const current = ranked[index]!;
          const previousTotal = previous.score.total;
          const currentTotal = current.score.total;

          // Unscored topics never precede a scored topic.
          if (previousTotal === null) {
            expect(currentTotal).toBeNull();
            continue;
          }
          if (currentTotal === null) continue;

          expect(previousTotal).toBeGreaterThanOrEqual(currentTotal);
          if (previousTotal === currentTotal) {
            // Score tie: the newer-created topic comes first.
            expect(Date.parse(previous.createdAt)).toBeGreaterThanOrEqual(
              Date.parse(current.createdAt),
            );
          }
        }
      }),
      RUNS,
    );
  });

  // Feature: fb-ai, Property 9: Threshold filtering admits exactly the qualifying topics
  it("Property 9: threshold filtering admits exactly the topics with score >= minScore", () => {
    const thresholdArb = fc.oneof(
      fc.constantFrom(0, 50, 99.9, 100),
      fc.double({ min: 0, max: 100, noNaN: true }),
    );
    const candidateArb = fc.array(
      fc.record({
        score: fc.oneof(
          fc.constantFrom<number | null>(0, 50, 99.9, 100, null),
          fc.double({ min: 0, max: 100, noNaN: true }),
        ),
        createdAt: createdAtArb,
        title: titleArb,
      }),
      { minLength: 0, maxLength: 8 },
    );

    fc.assert(
      fc.property(candidateArb, thresholdArb, (entries, minScore) => {
        const scorer = new TopicScorer({
          version: "score-v1",
          criteria: [{ id: "only", weightPercent: 100 }],
        });
        const topics = entries.map((entry, index) =>
          topicOf(
            `topic-${index}`,
            entry.createdAt,
            entry.title,
            entry.score === null
              ? UNSCORED
              : {
                  total: entry.score,
                  breakdown: [],
                  scoringConfigVersion: "score-v1",
                },
          ),
        );

        const admitted = scorer.advance(topics, minScore);
        const expected = topics.filter(
          (topic) => topic.score.total !== null && topic.score.total >= minScore,
        );

        expect(admitted.map((topic) => topic.id)).toEqual(
          expected.map((topic) => topic.id),
        );
        for (const topic of admitted) {
          expect(topic.score.total).not.toBeNull();
          expect(topic.score.total!).toBeGreaterThanOrEqual(minScore);
        }
      }),
      RUNS,
    );
  });

  // Feature: fb-ai, Property 10: Missing criterion input yields an unscored, excluded topic
  it("Property 10: missing criterion input yields total null, a reason, and exclusion from advance", () => {
    const missingCaseArb = fc
      .integer({ min: 1, max: MAX_CRITERIA })
      .chain((count) =>
        fc.record({
          count: fc.constant(count),
          parts: quarterPartsArb(count),
          components: fc.array(componentArb, {
            minLength: count,
            maxLength: count,
          }),
          omitted: fc
            .array(fc.boolean(), { minLength: count, maxLength: count })
            .map((mask) =>
              mask.some(Boolean)
                ? mask
                : mask.map((_, index) => index === 0),
            ),
          title: titleArb,
          createdAt: createdAtArb,
          threshold: fc.oneof(
            fc.constantFrom(0, 100),
            fc.double({ min: 0, max: 100, noNaN: true }),
          ),
        }),
      );

    fc.assert(
      fc.property(missingCaseArb, (testCase) => {
        const ids = criterionIds(testCase.count);
        const config: ScoringConfig = {
          version: "score-v1",
          criteria: ids.map((id, index) => ({
            id,
            weightPercent: testCase.parts[index]! / 4,
          })),
        };
        const values: Record<string, number | undefined> = {};
        ids.forEach((id, index) => {
          values[id] = testCase.omitted[index]
            ? undefined
            : testCase.components[index]!;
        });

        const scorer = new TopicScorer(config);
        const result = scorer.score(
          topicOf("unscored", testCase.createdAt, testCase.title, UNSCORED),
          values,
        );

        // No total, and an explicit unscored marker naming every missing input.
        expect(result.score.total).toBeNull();
        expect(typeof result.score.unscoredReason).toBe("string");
        expect(result.score.unscoredReason!.length).toBeGreaterThan(0);
        for (const [index, id] of ids.entries()) {
          if (testCase.omitted[index]) {
            expect(result.score.unscoredReason).toContain(id);
          }
        }

        // The partial explanation keeps exactly the criteria that had input.
        expect(result.score.breakdown.map((item) => item.criterionId)).toEqual(
          ids.filter((_, index) => !testCase.omitted[index]),
        );
        expect(result.score.scoringConfigVersion).toBe(config.version);

        // Excluded from the next step at every threshold, and ranked last.
        expect(scorer.advance([result], testCase.threshold)).toEqual([]);
        const scoredPeer = topicOf(
          "peer",
          testCase.createdAt,
          testCase.title,
          { total: 0, breakdown: [], scoringConfigVersion: "score-v1" },
        );
        expect(
          scorer.rank([result, scoredPeer]).map((topic) => topic.id),
        ).toEqual(["peer", "unscored"]);
      }),
      RUNS,
    );
  });
});
