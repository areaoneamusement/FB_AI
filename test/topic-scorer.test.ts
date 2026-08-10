import assert from "node:assert/strict";
import test from "node:test";

import type { Topic, TopicScore } from "../src/domain/content.js";
import { TopicScorer } from "../src/pipeline/topic-scorer.ts";

const config = {
  version: "score-v1",
  criteria: [
    { id: "novelty", weightPercent: 40 },
    { id: "sourceAuthority", weightPercent: 30 },
    { id: "aiRelevance", weightPercent: 30 },
  ],
} as const;

const unscored: TopicScore = {
  total: null,
  breakdown: [],
  scoringConfigVersion: "pending",
  unscoredReason: "Not scored yet",
};

function topic(id: string, createdAt: string, score: TopicScore = unscored): Topic {
  return {
    id,
    externalId: `external-${id}`,
    title: id,
    createdAt,
    score,
    categories: ["AI"],
    sourceRef: {
      sourceId: "source-1",
      captureId: `capture-${id}`,
      url: `https://example.com/${id}`,
      capturedAt: "2025-01-01T00:00:00.000Z",
      termsVersion: "terms-v1",
    },
  };
}

function scored(total: number): TopicScore {
  return {
    total,
    breakdown: [],
    scoringConfigVersion: "score-v1",
  };
}

test("score returns the weighted sum and complete persisted explanation", () => {
  const scorer = new TopicScorer(config);
  const original = topic("weighted", "2025-01-01T00:00:00.000Z");
  const result = scorer.score(original, {
    novelty: 80,
    sourceAuthority: 60,
    aiRelevance: 100,
  });

  assert.equal(result.score.total, 80);
  assert.equal(result.score.scoringConfigVersion, "score-v1");
  assert.deepEqual(result.score.breakdown, [
    { criterionId: "novelty", componentValue: 80, weightPercent: 40 },
    { criterionId: "sourceAuthority", componentValue: 60, weightPercent: 30 },
    { criterionId: "aiRelevance", componentValue: 100, weightPercent: 30 },
  ]);
  assert.equal(original.score.total, null);
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.score.breakdown));
});

test("missing criterion input produces an explained unscored topic", () => {
  const scorer = new TopicScorer(config);
  const result = scorer.score(topic("missing", "2025-01-01T00:00:00.000Z"), {
    novelty: 75,
    aiRelevance: 90,
  });

  assert.equal(result.score.total, null);
  assert.equal(
    result.score.unscoredReason,
    "Missing scoring input for criteria: sourceAuthority",
  );
  assert.deepEqual(result.score.breakdown, [
    { criterionId: "novelty", componentValue: 75, weightPercent: 40 },
    { criterionId: "aiRelevance", componentValue: 90, weightPercent: 30 },
  ]);
  assert.deepEqual(scorer.advance([result], 0), []);
});

test("rank orders scored topics descending with newer-first score ties", () => {
  const scorer = new TopicScorer(config);
  const topics = [
    topic("unscored", "2025-01-04T00:00:00.000Z"),
    topic("lower", "2025-01-03T00:00:00.000Z", scored(80)),
    topic("older-tie", "2025-01-01T00:00:00.000Z", scored(90)),
    topic("newer-tie", "2025-01-02T00:00:00.000Z", scored(90)),
  ];

  assert.deepEqual(
    scorer.rank(topics).map(({ id }) => id),
    ["newer-tie", "older-tie", "lower", "unscored"],
  );
  assert.deepEqual(topics.map(({ id }) => id), [
    "unscored",
    "lower",
    "older-tie",
    "newer-tie",
  ]);
});

test("advance includes exactly scored topics at or above the threshold", () => {
  const scorer = new TopicScorer(config);
  const topics = [
    topic("above", "2025-01-01T00:00:00.000Z", scored(80.1)),
    topic("boundary", "2025-01-01T00:00:00.000Z", scored(80)),
    topic("below", "2025-01-01T00:00:00.000Z", scored(79.9)),
    topic("unscored", "2025-01-01T00:00:00.000Z"),
  ];

  assert.deepEqual(
    scorer.advance(topics, 80).map(({ id }) => id),
    ["above", "boundary"],
  );
});

test("invalid configurations and out-of-range values are rejected", () => {
  assert.throws(
    () =>
      new TopicScorer({
        version: "bad",
        criteria: [{ id: "novelty", weightPercent: 99 }],
      }),
    /weights must total 100/,
  );
  const scorer = new TopicScorer(config);
  assert.throws(
    () =>
      scorer.score(topic("invalid", "2025-01-01T00:00:00.000Z"), {
        novelty: 101,
        sourceAuthority: 50,
        aiRelevance: 50,
      }),
    /must be a finite number in \[0, 100\]/,
  );
  assert.throws(() => scorer.advance([], -1), /must be a finite number/);
});
