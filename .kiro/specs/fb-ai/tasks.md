# Implementation Plan: FB_AI (Phase 1 / MVP)

## Overview

This plan implements the Phase 1 (MVP) content-production pipeline for FB_AI in **TypeScript on Node.js**, with a **React** review dashboard, **SQLite** persistence, and **Vitest + fast-check** for testing.

The MVP scope is the sequential pipeline:

```
Source collection → Topic scoring → Research aggregation → Multi-format generation
→ Two-model cross-verification → Compliance check → Sequential pipeline state machine
→ Review/approval dashboard → CopyReadyExporter (copy-ready export per platform)
```

Implementation follows these principles from the design:

- All external I/O (`SourceFetcher`, `ModelClient`, persistence) sits behind adapter interfaces so pipeline logic is testable with fakes.
- Output flows through a single `OutputPort` seam; Phase 1 wires it to `CopyReadyExporter`. Auto-publish (Req 9), group posting (Req 10), and encrypted credentials (Req 11) are **deferred to Phase 2** and are not implemented here.
- Correctness Properties 1–33 are implemented as `fast-check` property tests (minimum 100 iterations each), tagged `// Feature: fb-ai, Property N: ...`.
- Property/unit/integration test sub-tasks are marked optional with `*`.

## Tasks

- [ ] 1. Set up project structure, tooling, and core domain types
  - Initialize a Node.js + TypeScript project (tsconfig strict mode, ESM)
  - Add and configure Vitest and fast-check for testing
  - Create the directory layout: `src/domain` (types), `src/adapters` (ports + fakes), `src/pipeline`, `src/components`, `src/persistence`, `src/output`, `src/dashboard` (API + React SPA), `test/`
  - Define all core domain types and enums from the design's Data Models: `Stage`, `TargetPlatform`, `SourceConfig`, `SourceRegistry`, `SourceReference`, `RawItem`, `Topic`, `TopicScore`, `ScoreBreakdown`, `ScoringCriterion`, `ResearchItem`, `ResearchResult`, `ContentDraft`, `GuideSection`, `ImageSuggestion`, `VideoScript`, `Statement`, `VerificationFinding`, `VerificationReport`, `ComplianceRule`, `ComplianceResult`, `CopyrightLimits`, `PipelineItem`, `ExportBundle`, `DeliveryResult`, `SkipRecord`, `ErrorRecord`, `FormatError`, `SaveResult`
  - Define the canonical `Stage` ordering constant (Collected(0) → … → Published(8), plus terminal `Rejected`) used by the pipeline
  - _Requirements: 7.1_

- [ ] 2. Define adapter interfaces and fakes for external I/O
  - [ ] 2.1 Define port interfaces
    - Define `SourceFetcher` (`fetch`, `isAllowed`), `ModelClient` (Model_A generation / Model_B critique calls), and a `Repository` persistence interface covering topics, drafts, research results, verification reports, and compliance results with their `Stage`
    - Define `OutputPort` (`deliver(draft, platform, item)`)
    - _Requirements: 1.1, 5.1, 8.6_
  - [ ]* 2.2 Build in-memory fakes for tests
    - Implement fake `SourceFetcher`, fake `ModelClient`, and in-memory `Repository` for use across property and integration tests
    - _Requirements: 1.1, 5.1_

- [ ] 3. Implement Source_Collector (Req 1)
  - [ ] 3.1 Implement Source_Registry and collection cycle logic
    - Implement `SourceRegistry` with ≥3 source types, ≤500 sources per type, and priority/filter-mode ordering so best/highest-ranked filtered sources are processed first
    - Implement `SourceCollector.runCycle`: time-window filtering `[now - windowHours, now]`, per-request timeout (≤30s), retry (1–5, default 3), dedup by source identifier, terms/robots skip records, and per-source error records that preserve prior items and continue
    - Preserve GitHub metadata (stars, last-updated, latest changelog/release) on collected records
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7_
  - [ ]* 3.2 Property test: time-window filtering
    - **Property 1: Collected items fall within the configured time window**
    - **Validates: Requirements 1.2**
  - [ ]* 3.3 Property test: dedup + idempotence
    - **Property 2: Collection is deduplicated by source identifier**
    - **Validates: Requirements 1.5**
  - [ ]* 3.4 Property test: GitHub metadata preserved
    - **Property 3: GitHub metadata is preserved**
    - **Validates: Requirements 1.4**
  - [ ]* 3.5 Property test: disallowed sources skipped with reason
    - **Property 4: Disallowed sources are skipped with a reason**
    - **Validates: Requirements 1.6**
  - [ ]* 3.6 Property test: one failing source never drops others
    - **Property 5: One failing source never drops others**
    - **Validates: Requirements 1.7**
  - [ ]* 3.7 Property test: registry caps and priority focus
    - **Property 6: Registry respects per-type caps and priority focus**
    - **Validates: Requirements 1.1**
  - [ ]* 3.8 Unit test: per-request 30s timeout aborts and counts as failure
    - Test that a per-request fetch exceeding 30s aborts and is treated as a source failure
    - _Requirements: 1.3_

- [ ] 4. Implement Topic_Scorer (Req 2)
  - [ ] 4.1 Implement scoring, ranking, threshold, and unscored handling
    - Implement `score` as a weighted sum of component values (each ∈ [0,100], weights sum to 100 ⇒ total ∈ [0,100]) with persisted `breakdown`
    - Implement `rank` (descending by score, tie-break newer-created-first) and `advance` (keep score ≥ minScore and scored)
    - Handle missing criterion input: `total = null`, mark unscored, exclude from advance, record reason
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6_
  - [ ]* 4.2 Property test: bounded weighted-sum score
    - **Property 7: Score is the bounded weighted sum of components**
    - **Validates: Requirements 2.1, 2.2**
  - [ ]* 4.3 Property test: ranking order with tie-break
    - **Property 8: Topics are ranked by descending score with newer-first tie-break**
    - **Validates: Requirements 2.3**
  - [ ]* 4.4 Property test: threshold filtering
    - **Property 9: Threshold filtering admits exactly the qualifying topics**
    - **Validates: Requirements 2.4**
  - [ ]* 4.5 Property test: missing input yields unscored, excluded topic
    - **Property 10: Missing criterion input yields an unscored, excluded topic**
    - **Validates: Requirements 2.6**

- [ ] 5. Implement Research_Aggregator (Req 3)
  - [ ] 5.1 Implement research aggregation logic
    - Implement `aggregate`: gather items from origin + permitted related sources behind the `SourceFetcher` adapter, attach a source reference and `source`/`inferred` origin label to every item
    - Enforce `minItems` (default 3) ⇒ `insufficient_data` and no advance; per-source 15s timeout skip with recorded unreachable source; unreachable origin source ⇒ `insufficient_data`; overall 60s deadline
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6_
  - [ ]* 5.2 Property test: every item has provenance
    - **Property 11: Every research item has provenance**
    - **Validates: Requirements 3.2, 3.3**
  - [ ]* 5.3 Property test: insufficient data excludes topic
    - **Property 12: Insufficient data excludes a topic from generation**
    - **Validates: Requirements 3.4, 3.6**
  - [ ]* 5.4 Property test: unreachable related source does not abort
    - **Property 13: An unreachable related source does not abort aggregation**
    - **Validates: Requirements 3.5**
  - [ ]* 5.5 Unit test: related source 15s timeout is skipped and recorded
    - Test that a related source exceeding 15s is skipped while aggregation continues
    - _Requirements: 3.5_

- [ ] 6. Implement Content_Generator (Req 4)
  - [ ] 6.1 Implement multi-format draft generation
    - Implement generation via `Model_A` (`ModelClient`): produce `ContentDraft` with FB post (50–5000 chars), guide (≥3 sections, each with ≥1 image suggestion 10–500 chars), video script (intro/body/conclusion), and ≥1 origin link
    - Apply brand voice when configured; default language Vietnamese (`vi`)
    - On per-format failure, keep topic at research-completed and report exactly the failing format(s)
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6_
  - [ ]* 6.2 Property test: multi-format structure
    - **Property 14: Generated drafts satisfy the multi-format structure**
    - **Validates: Requirements 4.1, 4.3**
  - [ ]* 6.3 Property test: valid image suggestion per section
    - **Property 15: Every guide section has a valid image suggestion**
    - **Validates: Requirements 4.2**
  - [ ]* 6.4 Property test: default language Vietnamese
    - **Property 16: Default language is Vietnamese**
    - **Validates: Requirements 4.5**
  - [ ]* 6.5 Property test: per-format failure preserves state and reports format
    - **Property 17: Per-format failure preserves research state and reports the format**
    - **Validates: Requirements 4.6**
  - [ ]* 6.6 Unit test: brand voice carried into generation
    - Test that configured brand voice is applied to generated content
    - _Requirements: 4.4_

- [ ] 7. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 8. Implement Verification_Engine (Req 5)
  - [ ] 8.1 Implement two-model cross-verification
    - Implement `verify`: decompose draft into statements, have `Model_B` critique each statement against the research corpus, produce one finding per statement (`pass`/`contradiction`), attaching a research reference + description on contradiction
    - Drive transitions: zero contradictions ⇒ `Verified`; contradictions after `maxRounds` (1–5, default 2) ⇒ route to manual handling (never auto-approve); model unresponsive after retries (≤3) ⇒ hold at `Generated`, log error, notify Operator
    - Persist the verification report with the draft
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 5.8_
  - [ ]* 8.2 Property test: report covers every statement with a verdict
    - **Property 18: The verification report covers every statement with a verdict**
    - **Validates: Requirements 5.2, 5.4**
  - [ ]* 8.3 Property test: contradictions carry reference and description
    - **Property 19: Contradictions carry a research reference and description**
    - **Validates: Requirements 5.3**
  - [ ]* 8.4 Property test: verification outcome drives transition
    - **Property 20: Verification outcome drives the correct transition**
    - **Validates: Requirements 5.5, 5.6**
  - [ ]* 8.5 Unit test: unresponsive model holds draft at Generated and notifies
    - Test that model unresponsiveness after retries holds the draft at `Generated`, logs an error, and notifies the Operator
    - _Requirements: 5.7_

- [ ] 9. Implement Compliance_Checker (Req 6)
  - [ ] 9.1 Implement compliance, attribution, and copyright checks
    - Implement `check`: evaluate all configured community-standard rules per platform, `passed=false` with exact violated-rule-id list on any violation
    - Implement attribution check per `Source_Terms` and verbatim-copy detection (≥50 consecutive words OR ≥20% of total words, whichever first)
    - Handle missing standards/terms config ⇒ fail with config-unavailable error while preserving draft content; persist the full compliance result with the draft
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7_
  - [ ]* 9.2 Property test: pass reflects rule violations exactly
    - **Property 21: Compliance pass reflects rule violations exactly**
    - **Validates: Requirements 6.1, 6.2**
  - [ ]* 9.3 Property test: attribution required and checked
    - **Property 22: Attribution is required and checked**
    - **Validates: Requirements 6.3, 6.4**
  - [ ]* 9.4 Property test: verbatim copying beyond limit flagged
    - **Property 23: Verbatim copying beyond the limit is flagged**
    - **Validates: Requirements 6.5**
  - [ ]* 9.5 Unit test: config-unavailable failure preserves content
    - Test that missing standards/terms config marks the draft not-passing with a config-unavailable error and preserves content
    - _Requirements: 6.7_

- [ ] 10. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 11. Implement Content_Pipeline state machine (Req 7)
  - [ ] 11.1 Implement pipeline transitions, rejection, categories, and approval gate
    - Implement `advance` (exactly one adjacent stage, no skipping), `reject` (→ `Rejected` with 1–500 char reason + failing stage id, preserving draft data), `approve` (only from `PendingApproval` on explicit action), and `canDeliver` (true only when stage === `Approved`)
    - Assign 1–5 categories from the predefined category set to each topic
    - Refuse output/delivery requests while in automatic stages; enforce 300s automatic-stage timeout ⇒ `Rejected` with timeout reason + stage id
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7_
  - [ ]* 11.2 Property test: advance moves exactly one adjacent stage
    - **Property 24: Advancing moves exactly one adjacent stage, never skipping**
    - **Validates: Requirements 7.1, 7.2**
  - [ ]* 11.3 Property test: rejection recorded without destroying data
    - **Property 25: Rejection is recorded without destroying data**
    - **Validates: Requirements 7.3**
  - [ ]* 11.4 Property test: 1–5 categories from predefined set
    - **Property 26: Every topic has 1–5 categories from the predefined set**
    - **Validates: Requirements 7.4**
  - [ ]* 11.5 Property test: approval gate blocks output before approval
    - **Property 27: Approval gate blocks all output before approval**
    - **Validates: Requirements 7.5, 8.6, 8.7**
  - [ ]* 11.6 Property test: PendingApproval → Approved only on explicit approval
    - **Property 28: PendingApproval transitions to Approved only on explicit approval**
    - **Validates: Requirements 7.6, 8.3**
  - [ ]* 11.7 Unit test: automatic-stage 300s timeout rejection
    - Test that an automatic stage exceeding 300s is rejected with a timeout reason + stage id
    - _Requirements: 7.7_

- [ ] 12. Implement persistence layer (SQLite)
  - [ ] 12.1 Implement the Repository over SQLite
    - Implement the `Repository` interface over SQLite: persist topics, drafts, research results, and each entity's current `Stage` with transactional stage transitions
    - Persist and retrieve explainability artifacts: `TopicScore.breakdown`, `VerificationReport`, and `ComplianceResult` alongside their topic/draft; retain rejection records without overwriting draft data
    - _Requirements: 2.5, 5.8, 6.6, 7.3_
  - [ ]* 12.2 Property test: explainability artifacts persist with draft/topic
    - **Property 33: Explainability artifacts persist with their draft/topic**
    - **Validates: Requirements 2.5, 5.8, 6.6**
  - [ ]* 12.3 Integration test: persistence round-trip for artifacts
    - Persist and reload score breakdowns, verification reports, and compliance results and assert equality
    - _Requirements: 2.5, 5.8, 6.6_

- [ ] 13. Implement OutputPort and CopyReadyExporter (MVP output)
  - [ ] 13.1 Implement CopyReadyExporter
    - Implement `CopyReadyExporter implements OutputPort` as a pure per-platform rendering function guarded by the approval check (refuse unless `item.stage === "Approved"`)
    - Render `Facebook_Page`/`Facebook_Group` as FB post + attribution; `YouTube` as video script + metadata (title/description/tags); include origin attribution and image suggestions in the `ExportBundle`
    - Wire `OutputPort → CopyReadyExporter` for Phase 1
    - _Requirements: 4.1, 6.3, 8.6, 7.5_
  - [ ]* 13.2 Property test: export produces platform-correct, attributed content
    - **Property 32: Export produces platform-correct, attributed, copy-ready content**
    - **Validates: Requirements 4.1, 6.3, 8.6**
  - [ ] 13.3 Add deferred Phase 2 output seam placeholder (no implementation)
    - Add a clearly-marked TODO/interface note documenting that `ApiPublisher` (Req 9), `Group_Manager` (Req 10), and `Credential_Store` (Req 11) are Phase 2 adapters that slot behind the same `OutputPort` with no change to stages 0–7 — do NOT implement them
    - _Requirements: 9.1, 10.1, 11.1_

- [ ] 14. Implement Review_Dashboard API (Req 8)
  - [ ] 14.1 Implement the dashboard backend API
    - Implement `ReviewDashboardApi`: `listPending`, `getDraft` (draft + verification report + compliance results), `editDraft` (only while `PendingApproval`, ≤5000 chars per field), `approve` (→ `Approved`), `reject` (note 1–1000 chars → `Rejected` + saved note; empty/>1000 refused with unchanged state + error), `getExportBundle` (only when `Approved`)
    - Ensure saved edits persist and reload correctly; save failure preserves pre-edit content
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7, 8.8, 8.9_
  - [ ]* 14.2 Property test: edits bounded and only while pending
    - **Property 29: Edits are bounded and only allowed while pending**
    - **Validates: Requirements 8.2**
  - [ ]* 14.3 Property test: reject-with-note validity and persistence
    - **Property 30: Reject-with-note validity and persistence**
    - **Validates: Requirements 8.4, 8.5**
  - [ ]* 14.4 Property test: saved edits round-trip
    - **Property 31: Saved edits round-trip**
    - **Validates: Requirements 8.8**
  - [ ]* 14.5 Unit test: save-failure rollback preserves pre-edit content
    - Test that a failed save preserves the pre-edit draft content and surfaces an error
    - _Requirements: 8.9_

- [ ] 15. Implement Review_Dashboard React SPA (Req 8)
  - [ ] 15.1 Build the React review UI
    - Build a React SPA served by the backend that lists `PendingApproval` drafts (shown with verification report + compliance results within 5s), supports edit/approve/reject actions against `ReviewDashboardApi`, enforces the approval gate in the UI, and surfaces the copy-ready `ExportBundle` for the Operator to copy
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.6_
  - [ ]* 15.2 Unit test: pending draft renders with report + compliance
    - Test that a `PendingApproval` draft renders its verification report and compliance results
    - _Requirements: 8.1_

- [ ] 16. Integration and end-to-end wiring
  - [ ] 16.1 Wire the full MVP pipeline together
    - Compose `SourceCollector → TopicScorer → ResearchAggregator → ContentGenerator → VerificationEngine → ComplianceChecker → ContentPipeline → ReviewDashboard → OutputPort(CopyReadyExporter)` using the concrete adapters and SQLite repository, with no orphaned components
    - _Requirements: 7.1, 7.2, 8.6_
  - [ ]* 16.2 Integration test: end-to-end MVP happy path
    - Seed a source, flow a topic through all stages to an `Exported` copy-ready bundle, gated by a simulated Operator approval
    - _Requirements: 7.1, 8.3, 8.6_

- [ ] 17. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional test sub-tasks (property, unit, integration) and can be skipped for a faster MVP; core implementation tasks are never optional.
- Each property test runs a minimum of 100 generated cases and is tagged `// Feature: fb-ai, Property N: {property_text}`.
- Generators must include the edge cases named in the design's Testing Strategy (boundary lengths 49/50/5000/5001 and 9/10/500/501, notes 0/1/1000/1001, verbatim runs at 49/50 words and 19%/20%/21%, window-boundary timestamps, score ties, Vietnamese/non-ASCII text).
- Phase 2 capabilities — auto-publish (Req 9), automatic group posting (Req 10), and encrypted credential storage (Req 11) — are intentionally **not implemented** here; task 13.3 only documents the `OutputPort` seam that will host them later.
- Each task references specific requirement sub-clauses for traceability; checkpoints ensure incremental validation.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["2.1"] },
    { "id": 1, "tasks": ["2.2", "3.1", "4.1", "9.1", "11.1", "12.1"] },
    { "id": 2, "tasks": ["3.2", "3.3", "3.4", "3.5", "3.6", "3.7", "3.8", "4.2", "4.3", "4.4", "4.5", "5.1", "9.2", "9.3", "9.4", "9.5", "11.2", "11.3", "11.4", "11.5", "11.6", "11.7", "12.2", "12.3", "13.1", "13.3", "14.1"] },
    { "id": 3, "tasks": ["5.2", "5.3", "5.4", "5.5", "6.1", "13.2", "14.2", "14.3", "14.4", "14.5", "15.1"] },
    { "id": 4, "tasks": ["6.2", "6.3", "6.4", "6.5", "6.6", "8.1", "15.2", "16.1"] },
    { "id": 5, "tasks": ["8.2", "8.3", "8.4", "8.5", "16.2"] }
  ]
}
```
