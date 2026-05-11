export function createEvidenceLink({ ingestionId, mediaAssetId = null, sourceText = "", fieldPaths = [] }) {
  return {
    ingestionId,
    mediaAssetId,
    sourceText,
    fieldPaths,
    createdAt: new Date().toISOString(),
  };
}

export function hasFieldEvidence(evidence, field) {
  return Boolean(evidence?.fieldPaths?.includes(field) || evidence?.sourceText?.toLowerCase().includes(field.toLowerCase()));
}
