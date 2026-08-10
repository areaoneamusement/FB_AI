import { useMemo, useState } from "react";
import type {
  ApprovalDto,
  ExportBundleDto,
  PlatformArtifactDto,
  ReviewPackageDto,
} from "./api-client.js";

interface ApprovalPanelProps {
  readonly review: ReviewPackageDto;
  readonly approval?: ApprovalDto;
  readonly bundles: readonly ExportBundleDto[];
  readonly onApprove: (artifactIds: readonly string[]) => Promise<void>;
  readonly onReject: (note: string) => Promise<void>;
  readonly onExport: (artifact: PlatformArtifactDto, targetId: string) => Promise<void>;
}

function eligible(review: ReviewPackageDto, artifact: PlatformArtifactDto): boolean {
  return review.compliance.some((result) =>
    result.artifactId === artifact.id && result.artifactHash === artifact.artifactHash && result.passed,
  );
}

export function ApprovalPanel(props: ApprovalPanelProps) {
  const { review, approval, bundles, onApprove, onReject, onExport } = props;
  const [selected, setSelected] = useState<readonly string[]>([]);
  const [confirmed, setConfirmed] = useState(false);
  const [note, setNote] = useState("");
  const [targetIds, setTargetIds] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const isPending = review.run.stage === "PendingApproval";
  const approvedArtifacts = useMemo(() => review.artifacts.filter((artifact) => {
    const index = approval?.approvedArtifactIds.indexOf(artifact.id) ?? -1;
    return index >= 0 && approval?.approvedArtifactHashes[index] === artifact.artifactHash;
  }), [approval, review.artifacts]);

  async function perform(action: () => Promise<void>) {
    setBusy(true);
    try { await action(); } finally { setBusy(false); }
  }

  return (
    <section className="panel approval" aria-label="Approval gate">
      <div className="panel-heading">
        <div><p className="eyebrow">Human gate</p><h2>{approval ? "Approved artifacts" : "Review decision"}</h2></div>
        <span className={`status ${approval ? "pass" : "warning"}`}>{review.run.stage}</span>
      </div>

      {isPending ? (
        <>
          <p>Select the exact passing artifacts. Their stored hashes—not newly rendered content—will be approved.</p>
          <div className="artifact-options">
            {review.artifacts.map((artifact) => (
              <label className={eligible(review, artifact) ? "artifact-option" : "artifact-option disabled"} key={artifact.id}>
                <input type="checkbox" disabled={!eligible(review, artifact) || busy}
                  checked={selected.includes(artifact.id)} onChange={(event) => setSelected(event.target.checked
                    ? [...selected, artifact.id]
                    : selected.filter((id) => id !== artifact.id))} />
                <span><strong>{artifact.platform.replace("_", " ")}</strong><small>{artifact.artifactHash}</small></span>
              </label>
            ))}
          </div>
          <label className="confirmation"><input type="checkbox" checked={confirmed}
            onChange={(event) => setConfirmed(event.target.checked)} />
            I confirm approval of the selected exact artifacts.</label>
          <button disabled={busy || !confirmed || selected.length === 0} onClick={() => void perform(() => onApprove(selected))}>
            Approve selected artifacts
          </button>

          <div className="reject-box">
            <label>Rejection note <span>{note.length}/1000</span>
              <textarea maxLength={1000} rows={3} value={note} onChange={(event) => setNote(event.target.value)} />
            </label>
            <button className="danger" disabled={busy || note.trim().length === 0}
              onClick={() => void perform(() => onReject(note))}>Reject draft</button>
          </div>
        </>
      ) : null}

      {approval ? (
        <div className="export-area">
          <p className="inline-notice">Copy-ready exports are available only from these immutable approved artifacts.</p>
          {approvedArtifacts.map((artifact) => (
            <div className="export-control" key={artifact.id}>
              <div><strong>{artifact.platform.replace("_", " ")}</strong><small>{artifact.artifactHash}</small></div>
              <input aria-label={`Target for ${artifact.platform}`} placeholder="Target/account label"
                value={targetIds[artifact.id] ?? ""} onChange={(event) => setTargetIds({ ...targetIds, [artifact.id]: event.target.value })} />
              <button disabled={busy || !(targetIds[artifact.id]?.trim())}
                onClick={() => void perform(() => onExport(artifact, targetIds[artifact.id]!.trim()))}>Create copy-ready export</button>
            </div>
          ))}
          {bundles.map((bundle) => <ExportBundleCard bundle={bundle} key={bundle.id} />)}
        </div>
      ) : (
        <p className="gate-message">Export is locked until explicit approval succeeds.</p>
      )}
    </section>
  );
}

function ExportBundleCard({ bundle }: { readonly bundle: ExportBundleDto }) {
  const copy = (value: string) => navigator.clipboard.writeText(value);
  return (
    <article className="bundle">
      <div className="panel-heading"><h3>{bundle.platform.replace("_", " ")} copy-ready bundle</h3>
        <span className="status pass">Immutable export</span></div>
      <small>Artifact {bundle.artifactHash} · renderer {bundle.rendererVersion}</small>
      <pre>{bundle.body}</pre>
      <button className="secondary" onClick={() => void copy(bundle.body)}>Copy body</button>
      <h4>Attribution</h4><pre>{bundle.attribution}</pre>
      <button className="secondary" onClick={() => void copy(bundle.attribution)}>Copy attribution</button>
      {Object.entries(bundle.metadata).map(([key, value]) => (
        <div className="metadata" key={key}><strong>{key}</strong><span>{value}</span>
          <button className="quiet" onClick={() => void copy(value)}>Copy</button></div>
      ))}
    </article>
  );
}
