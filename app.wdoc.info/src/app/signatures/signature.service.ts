import { Injectable } from '@angular/core';
import JSZip from 'jszip';
import { readDocumentArchive } from './archive';
import { importJWK } from 'jose';
import { backendConfig } from '../config/app.config';
import { AuthService } from '../services/auth.service';
import { generateManifest } from '../services/manifest-builder';
import { assertFiles, assertKeyRegistry, decodeUtf8, isRecord, assertManifest, encoder, jcs, parseJson, safePath, sha256, verifyDocument, verifyJws, type Files, type KeyRecord, type Manifest, type Verification } from './core';

import { decodeLocal, finishAttestation, prepareAttestation, type LocalDocument, type PreparedAttestation } from './local-document';
export interface DocumentState extends LocalDocument {}
export interface PersonalSigningRequest { prepared: PreparedAttestation; kid: string; payload: Record<string, unknown> }
export interface FormSnapshot { formId: string; answers: Record<string, unknown[]>; attachments: Record<string, string> }
@Injectable({ providedIn: 'root' })
export class WdocSignatureService {
  public keys: KeyRecord[] = [];
  private pending: { fingerprint: string; requestId: string; prepared: PreparedAttestation } | null = null;
  private running = false;
  private base = backendConfig.authApiUrl.replace(/\/+$/, '');
  constructor(private auth: AuthService) {}
  async read(buffer: ArrayBuffer): Promise<DocumentState> {
    const { files: expanded, zip } = await readDocumentArchive(buffer);
    const files: Record<string, string> = Object.create(null);
    for (const [path, bytes] of Object.entries(expanded)) if (path !== 'manifest.json') {
      let binary = ''; for (const b of bytes) binary += String.fromCharCode(b);
      files[path] = btoa(binary);
    }
    const manifestText = expanded['manifest.json'] ? decodeUtf8(expanded['manifest.json']) : undefined;
    const existing = manifestText !== undefined ? parseJson(manifestText) : null;
    const manifest = manifestText !== undefined ? existing : await generateManifest(zip);
    assertManifest(manifest);
    return { manifest, files, version: 0, ...(manifestText !== undefined ? { manifestText } : {}) };
  }
  bytes(state: DocumentState): Files {
    return decodeLocal(state);
  }
  async verify(state: DocumentState): Promise<Verification> {
    let keys: KeyRecord[] = [];
    try {
      const registry = await this.request<{ keys: KeyRecord[]; allowedOrigins?: string[] }>('/signing-keys', undefined, false);
      if (!isRecord(registry) || Object.keys(registry).some(k => !['keys', 'allowedOrigins'].includes(k))) throw new Error('Invalid registry response');
      if (Object.hasOwn(registry, 'allowedOrigins')) assertKeyRegistry([], registry['allowedOrigins']);
      assertKeyRegistry(registry.keys, backendConfig.signingKeyOrigins);
      await Promise.all(registry.keys.map(k => importJWK(k.jwk, 'ES256')));
      keys = registry.keys;
    } catch { /* Unavailable or invalid registries never grant trust. */ }
    this.keys = keys;
    return verifyDocument(state.manifest, this.bytes(state), keys);
  }
  async operate(state: DocumentState, action: string, input: object = {}): Promise<DocumentState> {
    if ((input as { mode?: string }).mode === 'personal') throw new Error('Use a local personal signing provider.');
    if (this.running) throw new Error('A local signing operation is already in progress.');
    const session = this.auth.getCurrentSession();
    if (!session) throw new Error('Log in from the navigation menu before signing.');
    this.running = true;
    try {
      await this.verify(state);
      const fingerprint = await sha256(encoder.encode(jcs({ state, action, input, actor: session.user.id })));
      if (this.pending?.fingerprint !== fingerprint) this.pending = { fingerprint, requestId: crypto.randomUUID(), prepared: await prepareAttestation(state, action, input, this.keys) };
      const { prepared, requestId } = this.pending;
      // This is the sole upload boundary: only blinded commitments and an existing public proof.
      const receipt = await this.request<{ signatureId: string; jws: string }>(`/signatures/${prepared.kind}`, { requestId, ...prepared.body });
      if (!receipt || typeof receipt.signatureId !== 'string' || receipt.signatureId.length !== 36 || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(receipt.signatureId)) throw new Error('The server attestation does not match the local commitment and authenticated signer.');
      const result = await finishAttestation(prepared, receipt, this.keys, session.user.id);
      this.pending = null;
      return result;
    } finally { this.running = false; }
  }
  async preparePersonal(state: DocumentState, formId: string, input: object, kid: string): Promise<PersonalSigningRequest> {
    await this.verify(state);
    const key = this.keys.find(k => k.kid === kid && k.authority === 'personal' && k.status === 'active' && k.trusted && k.userId);
    if (!key) throw new Error('A trusted personal signing key is required.');
    const prepared = await prepareAttestation(state, `forms/${encodeURIComponent(formId)}/sign`, { ...input, mode: 'wdoc-attestation' }, this.keys);
    return { prepared, kid, payload: { type: 'wdoc-form-signature', proofMode: 'digest-only', ...prepared.claims, mode: 'personal', signer: { userId: key.userId!, displayName: key.owner }, signedAt: new Date().toISOString(), evidence: { scope: 'commitment-only' } } };
  }
  async completePersonal(request: PersonalSigningRequest, jws: string): Promise<DocumentState> {
    const result = await verifyJws(jws, 'form', this.keys);
    if (result.check.kid !== request.kid || result.check.authority !== 'personal' || !result.payload || jcs(result.payload) !== jcs(request.payload)) throw new Error('Personal signature does not match the reviewed local snapshot.');
    return finishAttestation(request.prepared, { signatureId: crypto.randomUUID(), jws }, this.keys, result.payload.signer.userId);
  }
  async archive(state: DocumentState): Promise<ArrayBuffer> {
    assertManifest(state.manifest); assertFiles(this.bytes(state));
    const zip = new JSZip();
    zip.file('manifest.json', state.manifestText ?? jcs(state.manifest));
    // Directory entries are optional and would otherwise inflate the entry count.
    for (const [path, data] of Object.entries(state.files)) zip.file(path, data, { base64: true, createFolders: false });
    return zip.generateAsync({ type: 'arraybuffer' });
  }
  async collect(form: HTMLFormElement, index: number, state: DocumentState): Promise<FormSnapshot> {
    if (!form.reportValidity()) throw new Error('Please complete the required form fields.');
    const formId = form.id || `form-${index + 1}`;
    if (!/^[\w-]{1,128}$/.test(formId)) throw new Error('Form IDs must contain letters, digits, underscores or hyphens.');
    const answers: Record<string, unknown[]> = Object.create(null);
    const attachments: Record<string, string> = Object.create(null);
    let attachmentIndex = 0;
    for (const [name, value] of new FormData(form)) {
      let answer: unknown = value;
      if (typeof value !== 'string') {
        const control = Array.from(form.querySelectorAll<HTMLInputElement>('input[type=file]')).find(c => c.name === name);
        const saved = control?.dataset['savedFile'];
        if (value.name) {
          const filename = `${++attachmentIndex}-${value.name}`;
          if (!safePath(filename) || filename.includes('/')) throw new Error('Unsafe attachment name.');
          const zip = new JSZip(); zip.file('file', await value.arrayBuffer());
          attachments[filename] = await zip.file('file')!.async('base64');
          answer = { attachment: filename, size: value.size };
        } else if (saved && state.files[`wdoc-form/${saved}`]) {
          const filename = `${++attachmentIndex}-${saved}`;
          attachments[filename] = state.files[`wdoc-form/${saved}`]; answer = { attachment: filename };
        } else answer = null;
      }
      (answers[name] ??= []).push(answer);
    }
    // Unchecked checkboxes and absent radio selections are explicit in the snapshot.
    for (const control of Array.from(form.querySelectorAll<HTMLInputElement>('input[type=checkbox], input[type=radio]'))) if (control.name && !answers[control.name]) answers[control.name] = [];
    return { formId, answers, attachments };
  }
  downloadAttachment(name: string, data: string) {
    const bytes = Uint8Array.from(atob(data), c => c.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = name.split('/').pop() || 'attachment'; anchor.click(); URL.revokeObjectURL(url);
  }
  download(buffer: ArrayBuffer) {
    const url = URL.createObjectURL(new Blob([buffer], { type: 'application/zip' }));
    const a = document.createElement('a'); a.href = url; a.download = 'signed.wdoc'; a.click(); URL.revokeObjectURL(url);
  }
  private async request<T>(path: string, body?: object, authenticated = true): Promise<T> {
    const session = this.auth.getCurrentSession();
    if (authenticated && !session) throw new Error('Log in from the navigation menu before signing.');
    const response = await fetch(`${this.base}${path}`, { method: body ? 'POST' : 'GET', headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(authenticated ? { Authorization: `Bearer ${session!.token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const data = parseJson(decodeUtf8(new Uint8Array(await response.arrayBuffer())));
    if (!response.ok) throw new ApiError(data?.error?.code ?? 'API_ERROR', data?.error?.message ?? 'Request failed.');
    return data;
  }
}
class ApiError extends Error { constructor(readonly code: string, message: string) { super(message); } }
