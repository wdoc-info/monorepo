import { archiveCommitment, assertFiles, assertManifest, commitment, documentDigest, encoder, formIds, inventory, isIdentifier, isRecord, jcs, newNonce, runtimePath, safePath, scopeOf, snapshotCommitment, verifyDocument, verifyJws, type Files, type KeyRecord, type Manifest, type Signature, type Submission } from './core';

export interface LocalDocument { manifestText?: string; manifest: Manifest; files: Record<string, string>; version: number }
export interface PreparedAttestation {
  state: LocalDocument;
  kind: 'document' | 'form' | 'seal';
  nonce: string;
  claims: Record<string, string>;
  body: Record<string, string | boolean>;
  formId?: string;
  submissionId?: string;
}
export function decodeLocal(state: LocalDocument): Files {
  const files: Files = Object.create(null);
  for (const [path, data] of Object.entries(state.files)) files[path] = Uint8Array.from(atob(data), c => c.charCodeAt(0));
  files['manifest.json'] = encoder.encode(state.manifestText ?? jcs(state.manifest));
  return files;
}
export async function encodeLocal(bytes: Uint8Array): Promise<string> {
  // Encode in chunks to avoid argument-size limits for attachments.
  let text = ''; for (const b of bytes) text += String.fromCharCode(b);
  return btoa(text);
}
function validateSize(state: LocalDocument) {
  const bytes = decodeLocal(state);
  assertFiles(bytes);
  for (const path of Object.keys(bytes)) if (!path.startsWith('.git/') && /\.(js|mjs|cjs|exe|sh|bat|cmd)$/i.test(path)) throw new Error('Unsafe archive path.');
}
async function documentProof(state: LocalDocument, keys: KeyRecord[], digest: string): Promise<{ jws: string; commitment: string }> {
  const report = await verifyDocument(state.manifest, decodeLocal(state), keys);
  for (const sig of state.manifest.signatures.document) {
    if (!sig.nonce || !report.document.some(c => c.signatureId === sig.signatureId && c.status === 'valid-trusted')) continue;
    const result = await verifyJws(sig.jws, 'document', keys);
    if (result.payload?.proofMode === 'digest-only') return { jws: sig.jws, commitment: await commitment('document', digest, sig.nonce) };
  }
  throw new Error('Sign the original document in private mode before signing a form or sealing.');
}
export async function prepareAttestation(source: LocalDocument, action: string, input: any, keys: KeyRecord[]): Promise<PreparedAttestation> {
  const state = structuredClone(source);
  let manifest = state.manifest;
  assertManifest(manifest); validateSize(state);
  const report = await verifyDocument(manifest, decodeLocal(state), keys);
  if (report.content.status === 'file-modified') throw new Error('Original content was modified. Create a content revision.');
  const nonce = newNonce();
  if (action === 'revisions') {
    const d = await documentDigest(manifest);
    const archived: Record<string, string> = {};
    for (const path of Object.keys(manifest.content.files)) {
      const target = `revisions/${d}/files/${path}`;
      state.files[target] = state.files[path]!; archived[path] = target; delete state.files[path];
    }
    const originals: Files = Object.create(null);
    for (const [path, value] of Object.entries(input.files as Record<string, string>)) {
      if (runtimePath(path) || !safePath(path) || path === 'manifest.json') throw new Error('Invalid original content path.');
      originals[path] = Uint8Array.from(atob(value), c => c.charCodeAt(0)); state.files[path] = value;
    }
    const old = manifest;
    const now = new Date().toISOString();
    manifest = { manifestVersion: '0.1', meta: { ...old.meta, contentUpdatedAt: now, appVersion: input.appVersion, docTitle: input.docTitle }, content: { hashAlgorithm: 'SHA-256', files: await inventory(originals), ...(input.externalFonts ? { externalFonts: input.externalFonts } : {}) }, runtime: old.runtime, signatures: { document: [], forms: old.signatures.forms } };
    manifest.runtime.revisions.push({ scope: scopeOf(old), signatures: old.signatures.document, files: archived });
    manifest.runtime.updatedAt = now;
    state.manifest = manifest; delete state.manifestText;
    const revised = await verifyDocument(manifest, decodeLocal(state), keys);
    if (revised.content.status === 'file-modified') throw new Error('The revised content must contain all original rendering resources.');
    action = 'sign';
  }
  const digest = await documentDigest(manifest);
  if (action === 'sign') {
    const value = await commitment('document', digest, nonce);
    return { state, kind: 'document', nonce, claims: { documentCommitment: value }, body: { documentCommitment: value, consent: true } };
  }
  const proof = await documentProof(state, keys, digest);
  if (action === 'seal') {
    if ([...report.document, ...report.forms, ...report.revisions].some(c => c.status !== 'valid-trusted')) throw new Error('All signatures must verify locally before sealing.');
    const value = await archiveCommitment(manifest, decodeLocal(state), '', nonce);
    return { state, kind: 'seal', nonce, claims: { documentCommitment: proof.commitment, archiveCommitment: value }, body: { documentProof: proof.jws, archiveCommitment: value, consent: true } };
  }
  const match = /^forms\/([^/]+)\/sign$/.exec(action);
  if (!match) throw new Error('Unsupported local signing action.');
  const formId = decodeURIComponent(match[1]);
  if (!/^[\w-]{1,128}$/.test(formId) || !safePath(formId)) throw new Error('Invalid form ID.');
  if (input.mode !== 'wdoc-attestation' || input.consent !== true) throw new Error('Explicit consent is required.');
  if (!formIds(new TextDecoder().decode(decodeLocal(state)['index.html'])).includes(formId) && !manifest.content.files[`forms/${formId}.json`]) throw new Error('Form not found in original content.');
  const submissions = manifest.runtime.submissions[formId] ??= [];
  let submission: Submission;
  if (input.submissionId) {
    const found = submissions.find(s => s.submissionId === input.submissionId);
    if (!found || found.documentDigest !== digest || input.answers !== undefined || input.attachments !== undefined || input.replaces) throw new Error('A co-signature must use an unchanged snapshot.');
    if (report.forms.some(c => c.submissionId === found.submissionId && c.status !== 'valid-trusted' && c.status !== 'unsigned')) throw new Error('Cannot co-sign a damaged snapshot.');
    submission = found;
  } else {
    if (input.answers === undefined) throw new Error('Answers are required.');
    if (input.replaces && !submissions.some(s => s.submissionId === input.replaces)) throw new Error('Previous submission not found.');
    const submissionId = crypto.randomUUID(); const prefix = `submissions/${submissionId}/`;
    state.files[`${prefix}answers.json`] = await encodeLocal(encoder.encode(jcs(input.answers)));
    const attachments: string[] = [];
    for (const [name, value] of Object.entries((input.attachments ?? {}) as Record<string, string>)) {
      if (!safePath(name) || name.includes('/') || /\.(html?|svg|js|mjs|cjs|exe|sh|bat|cmd)$/i.test(name)) throw new Error('Unsafe attachment name.');
      const path = `${prefix}attachments/${name}`; state.files[path] = value; attachments.push(path);
    }
    submission = { submissionId, answersFile: `${prefix}answers.json`, attachments, createdAt: new Date().toISOString(), documentDigest: digest, ...(input.replaces ? { replaces: input.replaces } : {}) };
    submissions.push(submission);
  }
  delete state.manifestText;
  manifest.runtime.updatedAt = new Date().toISOString();
  validateSize(state);
  const value = await snapshotCommitment(manifest, formId, submission, decodeLocal(state), nonce);
  return { state, kind: 'form', nonce, formId, submissionId: submission.submissionId, claims: { documentCommitment: proof.commitment, submissionCommitment: value }, body: { documentProof: proof.jws, submissionCommitment: value, consent: true } };
}
export async function finishAttestation(prepared: PreparedAttestation, receipt: { signatureId: string; jws: string }, keys: KeyRecord[], userId: string): Promise<LocalDocument> {
  if (!isRecord(receipt) || Object.keys(receipt).some(k => !['signatureId', 'jws'].includes(k)) || !isIdentifier(receipt.signatureId) || typeof receipt.jws !== 'string') throw new Error('The server attestation does not match the local commitment and authenticated signer.');
  const result = await verifyJws(receipt.jws, prepared.kind, keys);
  if (result.check.status !== 'valid-trusted' || result.payload?.proofMode !== 'digest-only' || result.payload.signer?.userId !== userId || Object.entries(prepared.claims).some(([key, value]) => result.payload[key] !== value) || !isIdentifier(receipt.signatureId)) throw new Error('The server attestation does not match the local commitment and authenticated signer.');
  const state = structuredClone(prepared.state);
  if ([...state.manifest.signatures.document, ...state.manifest.signatures.forms, ...state.manifest.runtime.revisions.flatMap(r => r.signatures)].some(s => s.signatureId === receipt.signatureId) || state.files[`seals/${receipt.signatureId}.jws`] || state.files[`seals/${receipt.signatureId}.nonce`]) throw new Error('The returned signature ID already exists in the local archive.');
  const signature: Signature = { ...receipt, nonce: prepared.nonce };
  if (prepared.kind === 'document') { state.manifest.signatures.document.push(signature); delete state.manifestText; }
  else if (prepared.kind === 'form') { state.manifest.signatures.forms.push({ ...signature, formId: prepared.formId, submissionId: prepared.submissionId }); delete state.manifestText; }
  else {
    state.files[`seals/${receipt.signatureId}.jws`] = await encodeLocal(encoder.encode(receipt.jws));
    state.files[`seals/${receipt.signatureId}.nonce`] = await encodeLocal(encoder.encode(prepared.nonce));
  }
  validateSize(state); state.version++;
  return state;
}
