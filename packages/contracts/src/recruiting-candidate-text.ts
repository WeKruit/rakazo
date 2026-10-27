// These are transport/provenance fields, not provider observations about the person.
const reportMetadata = new Set([
  "id",
  "taskid",
  "taskids",
  "providertaskid",
  "artifactid",
  "artifactids",
  "artifactref",
  "actionid",
  "effectid",
  "runid",
  "threadid",
  "roleid",
  "rolerevisionid",
  "sourceid",
  "shardid",
  "shardids",
  "outputid",
  "receiptid",
  "request",
  "response",
  "route",
  "routing",
  "cursor",
  "nextcursor",
  "requestcursor",
  "providerresult",
  "observation",
  "metadata",
  "traceid",
  "storagekey",
  "sha256",
  "hash",
  "toolname",
  "connectorid",
  "resourceid",
  "resourcerevision",
  "cataloggroup",
  "clientnonce",
]);

/** The same business/provenance boundary governs report display and retained row equivalence. */
export function isRecruitingCandidateReportField(key: string): boolean {
  return !key.startsWith("_") && !reportMetadata.has(key.replace(/[_-]/g, "").toLowerCase());
}

/** Recruiter-visible source text excludes operational IDs; immutable artifacts remain lossless. */
export function recruitingCandidateSourceText(value: unknown): string | undefined {
  return JSON.stringify(
    value,
    (key, nested) => (!key || isRecruitingCandidateReportField(key) ? nested : undefined),
    2,
  );
}
