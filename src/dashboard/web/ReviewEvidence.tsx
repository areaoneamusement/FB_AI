import type { ReviewPackageDto } from "./api-client.js";

interface ReviewEvidenceProps {
  readonly review: ReviewPackageDto;
  readonly superseded?: boolean;
}

export function ReviewEvidence({ review, superseded = false }: ReviewEvidenceProps) {
  const report = review.verification;
  return (
    <section className={`panel evidence ${superseded ? "superseded" : ""}`} aria-label="Verification and compliance">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Exact evidence</p>
          <h2>Verification &amp; compliance</h2>
        </div>
        {superseded ? <span className="status warning">Superseded — re-verification required</span> : null}
      </div>

      <div className="evidence-grid">
        <article>
          <h3>Verification</h3>
          {report === undefined ? (
            <p className="muted">No current verification exists for this revision.</p>
          ) : (
            <>
              <p className={`status ${report.passed ? "pass" : "fail"}`}>
                {report.passed ? "Passed" : "Needs attention"} · {report.findings.length} claims
              </p>
              <ul className="finding-list">
                {report.findings.map((finding) => (
                  <li key={finding.claimId}>
                    <strong>{finding.verdict}</strong>
                    <span>{finding.description ?? finding.claimId}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </article>

        <article>
          <h3>Platform compliance</h3>
          {review.artifacts.map((artifact) => {
            const result = review.compliance.find(
              (item) => item.artifactId === artifact.id && item.artifactHash === artifact.artifactHash,
            );
            return (
              <div className="compliance-row" key={artifact.id}>
                <div><strong>{artifact.platform.replace("_", " ")}</strong><small>{artifact.artifactHash}</small></div>
                <span className={`status ${result?.passed ? "pass" : "fail"}`}>
                  {result?.passed ? "Passed" : "Blocked"}
                </span>
                {result !== undefined && !result.passed ? (
                  <p>{[...result.violatedRuleIds, ...result.reasons].join(" · ") || "Compliance failed"}</p>
                ) : null}
              </div>
            );
          })}
        </article>
      </div>
    </section>
  );
}
