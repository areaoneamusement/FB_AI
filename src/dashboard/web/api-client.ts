export type TargetPlatformDto = "Facebook_Page" | "Facebook_Group" | "YouTube";

export interface ContentDraftDto {
  readonly topicId: string;
  readonly facebookPost: string;
  readonly guide: readonly {
    readonly heading: string;
    readonly body: string;
    readonly imageSuggestions: readonly { readonly description: string }[];
  }[];
  readonly videoScript: {
    readonly intro: string;
    readonly body: string;
    readonly conclusion: string;
  };
  readonly originLinks: readonly string[];
  readonly language: string;
  readonly brandVoiceVersion?: string;
}

export interface ReviewPackageDto {
  readonly run: {
    readonly id: string;
    readonly stage: string;
    readonly workStatus: string;
    readonly version: number;
  };
  readonly revision: {
    readonly id: string;
    readonly revision: number;
    readonly contentHash: string;
    readonly content: ContentDraftDto;
  };
  readonly verification?: {
    readonly id: string;
    readonly draftRevisionId: string;
    readonly contentHash: string;
    readonly passed: boolean;
    readonly findings: readonly {
      readonly claimId: string;
      readonly verdict: "Pass" | "Contradiction" | "Unsupported";
      readonly description?: string;
    }[];
  };
  readonly artifacts: readonly PlatformArtifactDto[];
  readonly compliance: readonly ComplianceResultDto[];
}
export interface PlatformArtifactDto {
  readonly id: string;
  readonly draftRevisionId: string;
  readonly platform: TargetPlatformDto;
  readonly rendererVersion: string;
  readonly body: string;
  readonly metadata: Readonly<Record<string, string>>;
  readonly attribution: string;
  readonly artifactHash: string;
}

export interface ComplianceResultDto {
  readonly id: string;
  readonly artifactId: string;
  readonly artifactHash: string;
  readonly platform: TargetPlatformDto;
  readonly passed: boolean;
  readonly violatedRuleIds: readonly string[];
  readonly attributionOk: boolean;
  readonly copyrightOk: boolean;
  readonly reasons: readonly string[];
}

export interface ApprovalDto {
  readonly id: string;
  readonly draftRevisionId: string;
  readonly contentHash: string;
  readonly approvedArtifactIds: readonly string[];
  readonly approvedArtifactHashes: readonly string[];
}

export interface ExportBundleDto {
  readonly id: string;
  readonly platform: TargetPlatformDto;
  readonly targetId: string;
  readonly approvalId: string;
  readonly artifactId: string;
  readonly artifactHash: string;
  readonly rendererVersion: string;
  readonly body: string;
  readonly metadata: Readonly<Record<string, string>>;
  readonly attribution: string;
  readonly imageSuggestions: readonly { readonly description: string }[];
  readonly createdAt: string;
}

export interface PendingReviewDto {
  readonly pipelineRunId: string;
  readonly stage: string;
  readonly status: string;
  readonly version: number;
  readonly reviewPackage: ReviewPackageDto;
}

export interface ApproveReviewInput {
  readonly expectedVersion: number;
  readonly confirmed: true;
  readonly draftRevisionId: string;
  readonly contentHash: string;
  readonly verificationReportId: string;
  readonly complianceResultIds: readonly string[];
  readonly artifactIds: readonly string[];
  readonly artifactHashes: readonly string[];
}
export interface ReviewDashboardClient {
  listPending(signal?: AbortSignal): Promise<readonly PendingReviewDto[]>;
  editDraft(id: string, expectedVersion: number, content: ContentDraftDto): Promise<ReviewPackageDto["revision"]>;
  approve(id: string, input: ApproveReviewInput): Promise<ApprovalDto>;
  reject(id: string, expectedVersion: number, note: string): Promise<void>;
  exportArtifact(
    id: string,
    approval: ApprovalDto,
    artifact: PlatformArtifactDto,
    targetId: string,
  ): Promise<ExportBundleDto>;
}

export class ReviewDashboardClientError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ReviewDashboardClientError";
  }
}

interface ErrorPayload { readonly error?: { readonly code?: string; readonly message?: string } }

export class HttpReviewDashboardClient implements ReviewDashboardClient {
  private csrfToken?: string;

  constructor(
    private readonly basePath = "/api/reviews",
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async listPending(signal?: AbortSignal): Promise<readonly PendingReviewDto[]> {
    const payload = await this.request<{ readonly reviews: readonly PendingReviewDto[] }>(
      `${this.basePath}/pending`, { signal },
    );
    return payload.reviews;
  }

  editDraft(id: string, expectedVersion: number, content: ContentDraftDto) {
    return this.mutate<ReviewPackageDto["revision"]>(`${this.basePath}/${encodeURIComponent(id)}/draft`, "PATCH", {
      expectedVersion, content, idempotencyKey: crypto.randomUUID(),
    });
  }

  approve(id: string, input: ApproveReviewInput) {
    return this.mutate<ApprovalDto>(`${this.basePath}/${encodeURIComponent(id)}/approve`, "POST", {
      ...input, idempotencyKey: crypto.randomUUID(),
    });
  }

  async reject(id: string, expectedVersion: number, note: string): Promise<void> {
    await this.mutate(`${this.basePath}/${encodeURIComponent(id)}/reject`, "POST", {
      expectedVersion, note, idempotencyKey: crypto.randomUUID(),
    });
  }

  exportArtifact(id: string, approval: ApprovalDto, artifact: PlatformArtifactDto, targetId: string) {
    return this.mutate<ExportBundleDto>(`${this.basePath}/${encodeURIComponent(id)}/export`, "POST", {
      approvalId: approval.id,
      artifactId: artifact.id,
      artifactHash: artifact.artifactHash,
      targetId,
      idempotencyKey: crypto.randomUUID(),
    });
  }

  private async mutate<T>(url: string, method: string, body: unknown): Promise<T> {
    if (this.csrfToken === undefined) {
      const session = await this.request<{ readonly csrfToken: string }>("/api/review-session");
      this.csrfToken = session.csrfToken;
    }
    return this.request<T>(url, {
      method,
      headers: { "content-type": "application/json", "x-csrf-token": this.csrfToken },
      body: JSON.stringify(body),
    });
  }

  private async request<T>(url: string, init: RequestInit = {}): Promise<T> {
    const response = await this.fetchImpl(url, { ...init, credentials: "same-origin" });
    const payload = await response.json() as T & ErrorPayload;
    if (!response.ok) {
      throw new ReviewDashboardClientError(
        payload.error?.code ?? "REQUEST_FAILED",
        payload.error?.message ?? `Request failed with status ${response.status}`,
      );
    }
    return payload;
  }
}
