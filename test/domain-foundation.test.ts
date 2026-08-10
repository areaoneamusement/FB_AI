import { describe, expect, it } from "vitest";

import {
  SUCCESSFUL_WORKFLOW_STAGES,
  WORKFLOW_STAGE_INDEX,
  type DeliveryStatus,
  type WorkflowStage,
} from "../src/domain/workflow.js";

describe("domain workflow foundation", () => {
  it("defines the strict successful content workflow through approval", () => {
    expect(SUCCESSFUL_WORKFLOW_STAGES).toEqual([
      "Collected",
      "Scored",
      "Researched",
      "Generated",
      "Verified",
      "ComplianceChecked",
      "PendingApproval",
      "Approved",
    ]);
    expect(WORKFLOW_STAGE_INDEX).toEqual({
      Collected: 0,
      Scored: 1,
      Researched: 2,
      Generated: 3,
      Verified: 4,
      ComplianceChecked: 5,
      PendingApproval: 6,
      Approved: 7,
    });
  });

  it("keeps rejection terminal and publication in delivery state", () => {
    const rejected: WorkflowStage = "Rejected";
    const published: DeliveryStatus = "Published";

    expect(SUCCESSFUL_WORKFLOW_STAGES).not.toContain(rejected);
    expect(published).toBe("Published");
  });
});
