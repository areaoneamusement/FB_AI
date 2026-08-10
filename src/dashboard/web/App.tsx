import { useEffect, useState } from "react";
import { ApprovalPanel } from "./ApprovalPanel.js";
import { DraftEditor } from "./DraftEditor.js";
import { ReviewEvidence } from "./ReviewEvidence.js";
import type {
  ApprovalDto,
  ContentDraftDto,
  ExportBundleDto,
  PendingReviewDto,
  ReviewDashboardClient,
  ReviewPackageDto,
} from "./api-client.js";

const REVIEW_LOAD_DEADLINE_MS = 5_000;

export function App({ client }: { readonly client: ReviewDashboardClient }) {
  const [queue, setQueue] = useState<readonly PendingReviewDto[]>([]);
  const [selected, setSelected] = useState<ReviewPackageDto>();
  const [approval, setApproval] = useState<ApprovalDto>();
  const [bundles, setBundles] = useState<readonly ExportBundleDto[]>([]);
  const [superseded, setSuperseded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  useEffect(() => {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), REVIEW_LOAD_DEADLINE_MS);
    client.listPending(controller.signal).then((reviews) => {
      setQueue(reviews);
      setSelected(reviews[0]?.reviewPackage);
    }).catch((reason: unknown) => {
      setError(reason instanceof DOMException && reason.name === "AbortError"
        ? "The review queue did not load within 5 seconds. Try again."
        : messageFor(reason));
    }).finally(() => {
      window.clearTimeout(timeout);
      setLoading(false);
    });
    return () => { window.clearTimeout(timeout); controller.abort(); };
  }, [client]);

  function choose(item: PendingReviewDto) {
    setSelected(item.reviewPackage);
    setApproval(undefined);
    setBundles([]);
    setSuperseded(false);
    setError(undefined);
  }

  async function saveEdit(content: ContentDraftDto) {
    if (selected === undefined) return;
    try {
      const revision = await client.editDraft(selected.run.id, selected.run.version, content);
      setQueue((current) => current.filter((item) => item.pipelineRunId !== selected.run.id));
      setSelected({
        ...selected,
        run: { ...selected.run, stage: "Generated", workStatus: "Ready", version: selected.run.version + 1 },
        revision,
      });
      setSuperseded(true);
      setError(undefined);
    } catch (reason) { setError(messageFor(reason)); }
  }

  async function approve(artifactIds: readonly string[]) {
    if (selected?.verification === undefined) return;
    const artifacts = artifactIds.map((id) => selected.artifacts.find((item) => item.id === id)).filter(isPresent);
    const compliance = artifacts.map((artifact) => selected.compliance.find((result) =>
      result.artifactId === artifact.id && result.artifactHash === artifact.artifactHash && result.passed)).filter(isPresent);
    if (artifacts.length !== artifactIds.length || compliance.length !== artifacts.length) {
      setError("Every selected artifact must have an exact passing compliance result.");
      return;
    }
    try {
      const record = await client.approve(selected.run.id, {
        expectedVersion: selected.run.version,
        confirmed: true,
        draftRevisionId: selected.revision.id,
        contentHash: selected.revision.contentHash,
        verificationReportId: selected.verification.id,
        complianceResultIds: compliance.map((item) => item.id),
        artifactIds: artifacts.map((item) => item.id),
        artifactHashes: artifacts.map((item) => item.artifactHash),
      });
      setApproval(record);
      setSelected({ ...selected, run: { ...selected.run, stage: "Approved", version: selected.run.version + 1 } });
      setQueue((current) => current.filter((item) => item.pipelineRunId !== selected.run.id));
      setError(undefined);
    } catch (reason) { setError(messageFor(reason)); }
  }

  async function reject(note: string) {
    if (selected === undefined) return;
    try {
      await client.reject(selected.run.id, selected.run.version, note);
      setSelected({ ...selected, run: { ...selected.run, stage: "Rejected", workStatus: "Rejected", version: selected.run.version + 1 } });
      setQueue((current) => current.filter((item) => item.pipelineRunId !== selected.run.id));
      setError(undefined);
    } catch (reason) { setError(messageFor(reason)); }
  }

  async function exportArtifact(artifact: ReviewPackageDto["artifacts"][number], targetId: string) {
    if (selected === undefined || approval === undefined) return;
    try {
      const bundle = await client.exportArtifact(selected.run.id, approval, artifact, targetId);
      setBundles((current) => [...current.filter((item) => item.id !== bundle.id), bundle]);
      setError(undefined);
    } catch (reason) { setError(messageFor(reason)); }
  }

  return (
    <div className="shell">
      <header className="topbar">
        <div><p className="eyebrow">FB_AI · Operator workspace</p><h1>Review desk</h1></div>
        <span className="queue-count">{queue.length} pending</span>
      </header>
      <div className="layout">
        <aside className="queue" aria-label="Pending approval drafts">
          <h2>Pending approval</h2>
          {loading ? <p>Loading exact review packages…</p> : null}
          {!loading && queue.length === 0 ? <p className="muted">No drafts are waiting.</p> : null}
          {queue.map((item) => (
            <button className={selected?.run.id === item.pipelineRunId ? "queue-item active" : "queue-item"}
              key={item.pipelineRunId} onClick={() => choose(item)}>
              <span>Revision {item.reviewPackage.revision.revision}</span>
              <strong>{item.reviewPackage.revision.content.topicId}</strong>
              <small>{item.pipelineRunId} · v{item.version}</small>
            </button>
          ))}
        </aside>

        <main>
          {error ? <div className="error-banner" role="alert">{error}</div> : null}
          {selected === undefined && !loading ? <section className="empty-state"><h2>Queue clear</h2><p>Pending drafts will appear here with their exact evidence.</p></section> : null}
          {selected !== undefined ? (
            <>
              <section className="review-hero">
                <div><p className="eyebrow">Pipeline {selected.run.id}</p><h2>{selected.revision.content.topicId}</h2></div>
                <div className="revision-chip">Revision {selected.revision.revision}<small>{selected.revision.contentHash}</small></div>
              </section>
              {superseded ? <div className="error-banner warning-banner" role="status">
                Your edit created a new immutable revision. The evidence below belongs to the superseded revision and cannot authorize approval.
              </div> : null}
              <ReviewEvidence review={selected} superseded={superseded} />
              <DraftEditor key={selected.revision.id} content={selected.revision.content}
                disabled={selected.run.stage !== "PendingApproval"} onSave={saveEdit} />
              <ApprovalPanel review={selected} approval={approval} bundles={bundles}
                onApprove={approve} onReject={reject} onExport={exportArtifact} />
            </>
          ) : null}
        </main>
      </div>
    </div>
  );
}

function isPresent<T>(value: T | undefined): value is T { return value !== undefined; }
function messageFor(reason: unknown): string {
  return reason instanceof Error ? reason.message : "The operation could not be completed.";
}
