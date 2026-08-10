import type { OutputPort } from "../adapters/ports.js";

/**
 * TODO(Phase 2 — documentation seam only; do not implement in the MVP):
 *
 * Future delivery composition places these adapters behind the same `OutputPort`:
 * - `ApiPublisher` (Requirement 9.1) sends approved artifacts through official APIs.
 * - `Group_Manager` (Requirement 10.1) schedules approved Facebook Group delivery.
 * - `Credential_Store` (Requirement 11.1) supplies encrypted credentials only to those
 *   delivery adapters; it does not introduce a second output/workflow contract.
 *
 * Phase 2 must consume the immutable approved artifact and exact hash through
 * `OutputPort.deliver`. It may update per-target delivery state, but it must not
 * change or bypass content workflow stages 0–7 (`Collected` through `Approved`).
 * Phase 1 remains wired only to `CopyReadyExporter`.
 */
export type Phase2OutputAdapterContract = OutputPort;
