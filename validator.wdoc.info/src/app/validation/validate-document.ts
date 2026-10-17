import Ajv, { type AnySchema, type ErrorObject } from 'ajv';
import addFormats from 'ajv-formats';
import { parse, type DefaultTreeAdapterMap } from 'parse5';
import { readDocumentArchive } from '../format/archive';
import { assertManifest, decodeBase64url, decodeUtf8, dependenciesValid, documentDigest, isDigest, isIdentifier, isRecord, jcs, parseJson, runtimePath, sha256, verifyDocument, type Check, type Files, type Manifest, type Scope, type Status, type Verification } from '../format/core';
import { assertPayload } from '../format/validation';
import { type TrustContext, emptyTrust } from './verification-keys';
import commonSchema from '../format/schemas/common.schema.json';
import manifestSchema from '../format/schemas/manifest.schema.json';
import headerSchema from '../format/schemas/protected-header.schema.json';
import documentSchema from '../format/schemas/document-jws.schema.json';
import formSchema from '../format/schemas/form-jws.schema.json';
import sealSchema from '../format/schemas/seal-jws.schema.json';
export type FindingLevel = 'pass' | 'error' | 'warning' | 'info';
export interface Finding {
    id: string;
    level: FindingLevel;
    title: string;
    detail: string;
    section: string;
    path?: string;
}
export type SignatureKind = 'document' | 'form' | 'revision' | 'seal';
export interface SignatureResult extends Check {
    kind: SignatureKind;
    outcome: 'verified' | 'unverified' | 'failed' | 'obsolete' | 'unsigned';
    label: string;
    explanation: string;
}
export interface FileEntry {
    path: string;
    size: number;
    kind: 'original' | 'manifest' | 'draft' | 'submission' | 'revision' | 'seal';
}
export interface ValidationReport {
    specification: 'WDOC-FORMAT 1.0';
    checkedAt: string;
    verdict: 'valid' | 'invalid' | 'unverified';
    format: 'valid' | 'invalid';
    documentDigest: string | null;
    rootPrefix: string | null;
    expandedBytes: number;
    files: FileEntry[];
    checks: Finding[];
    recommendations: Finding[];
    needsKeys: boolean;
    signatures: {
        state: 'not-checked' | 'unsigned' | 'verified' | 'unverified' | 'invalid';
        count: number;
        results: SignatureResult[];
    };
    trust: {
        source: string;
        state: TrustContext['state'];
        detail?: string;
    };
}
const ajv = new Ajv({ allErrors: false, strict: false, validateFormats: true });
addFormats(ajv);
for (const schema of [commonSchema, manifestSchema, headerSchema, documentSchema, formSchema, sealSchema])
    ajv.addSchema(schema as AnySchema);
const schemaBase = 'https://www.wdoc.info/schemas/';
const validateManifest = ajv.getSchema(schemaBase + 'manifest.schema.json')!;
const validateHeader = ajv.getSchema(schemaBase + 'protected-header.schema.json')!;
const message = (error: unknown) => error instanceof Error ? error.message : 'Validation could not be completed.';
const issue = (id: string, level: FindingLevel, title: string, detail: string, section: string, path?: string): Finding => ({ id, level, title, detail, section, ...(path ? { path } : {}) });
const schemaMessage = (errors: ErrorObject[] | null | undefined) => {
    const error = errors?.[0];
    return error ? `${error.instancePath || '/'} ${error.message ?? 'is invalid'}${'missingProperty' in error.params ? ` (${String(error.params['missingProperty'])})` : ''}` : 'Invalid structure.';
};
function fileKind(path: string): FileEntry['kind'] {
    if (path === 'manifest.json')
        return 'manifest';
    for (const [prefix, kind] of [['wdoc-form/', 'draft'], ['submissions/', 'submission'], ['revisions/', 'revision'], ['seals/', 'seal']] as const)
        if (path.startsWith(prefix))
            return kind;
    return 'original';
}
function finish(report: ValidationReport): ValidationReport {
    report.format = report.checks.some(c => c.level === 'error') ? 'invalid' : 'valid';
    report.verdict = report.format === 'invalid' || report.signatures.state === 'invalid' ? 'invalid' : report.signatures.state === 'unverified' ? 'unverified' : 'valid';
    return report;
}
function elements(document: DefaultTreeAdapterMap['document']): DefaultTreeAdapterMap['element'][] {
    const nodes: DefaultTreeAdapterMap['element'][] = [];
    const visit = (node: DefaultTreeAdapterMap['node']) => {
        if ('tagName' in node)
            nodes.push(node);
        if ('childNodes' in node)
            for (const child of node.childNodes)
                visit(child);
        if ('content' in node)
            visit((node as DefaultTreeAdapterMap['template']).content);
    };
    visit(document);
    return nodes;
}
function inspectHtml(html: string, report: ValidationReport) {
    const parsed = parse(html, { sourceCodeLocationInfo: true }), nodes = elements(parsed);
    const attr = (node: DefaultTreeAdapterMap['element'], key: string) => node.attrs.find(a => a.name === key)?.value;
    const missing: string[] = [];
    if (!parsed.childNodes.some(n => n.nodeName === '#documentType'))
        missing.push('a doctype');
    for (const tag of ['html', 'head', 'body'])
        if (!nodes.some(n => n.tagName === tag && n.sourceCodeLocation))
            missing.push(`an explicit <${tag}> element`);
    if (!nodes.some(n => n.tagName === 'meta' && /^utf-?8$/i.test(attr(n, 'charset') ?? '')))
        missing.push('a UTF-8 charset declaration');
    if (!nodes.some(n => n.tagName === 'title' && n.childNodes.some(c => 'value' in c && c.value.trim())))
        missing.push('a nonempty title');
    if (missing.length)
        report.recommendations.push(issue('html-shell', 'warning', 'Complete the HTML document', `Consider adding ${missing.join(', ')}. HTML fragments remain valid.`, '5.1', 'index.html'));
    const forms = nodes.filter(n => n.tagName === 'form'), ids = forms.map(n => attr(n, 'id'));
    if (forms.length && (ids.some(id => !isIdentifier(id)) || new Set(ids).size !== ids.length))
        report.recommendations.push(issue('form-ids', 'warning', 'Give forms stable, unique IDs', 'Explicit IDs make draft restoration and signed submissions easier to identify. Use letters, digits, underscores, or hyphens.', '8.1', 'index.html'));
    const supported = new Set(['wdoc-container', 'wdoc-page', 'wdoc-content', 'wdoc-header', 'wdoc-footer', 'wdoc-pagenum', 'wdoc-nbpages', 'wdoc-date', 'wdoc-barcode']);
    const unknown = [...new Set(nodes.filter(n => n.tagName.startsWith('wdoc-') && !supported.has(n.tagName)).map(n => n.tagName))];
    if (unknown.length)
        report.recommendations.push(issue('unknown-elements', 'warning', 'Use supported wdoc elements', `These elements are not supported by this profile: ${unknown.slice(0, 10).join(', ')}.`, '5.2', 'index.html'));
}
async function inspectInventory(scope: Scope, files: Files, report: ValidationReport, prefix = '') {
    let ok = true;
    for (const [path, expected] of Object.entries(scope.content.files)) {
        if (!Object.hasOwn(files, path)) {
            ok = false;
            report.checks.push(issue(`missing:${prefix}${path}`, 'error', 'An original file is missing', 'Every inventoried original must exist.', '7', prefix + path));
        }
        else if (await sha256(files[path]!) !== expected) {
            ok = false;
            report.checks.push(issue(`hash:${prefix}${path}`, 'error', 'Original bytes do not match their hash', 'The actual file bytes differ from content.files.', '7', prefix + path));
        }
    }
    return ok;
}
const statusText: Record<Status, [
    string,
    string
]> = {
    'valid-trusted': ['Verified · trusted key', 'The signature, its scope, its files, and the configured key policy all verify.'],
    'valid-untrusted': ['Valid math · untrusted identity', 'Cryptography verifies, but this key is not trusted by the selected registry.'],
    'file-modified': ['File modified or missing', 'The protected file set, bytes, dependencies, or local snapshot opening do not match.'],
    'invalid-signature': ['Invalid signature', 'JWS structure, payload, or ES256 signature verification failed.'],
    'key-unavailable': ['Public key unavailable', 'The selected registry does not contain the public key needed to verify this signature.'],
    'key-unauthorized': ['Key not authorized', 'Key status, validity, authority, identity association, or header policy prohibits this signature.'],
    'wrong-revision': ['Original binding failed', 'The commitment does not bind to the expected trusted document or submission.'],
    'unsigned': ['Unsigned', 'No signature is present for this scope.'],
    'archive-changed': ['Archive changed since seal', 'This seal does not cover the complete supplied snapshot.'],
};
function signatureResults(verification: Verification, malformed: Set<string>): SignatureResult[] {
    const hasCurrentSeal = verification.seals.some(s => s.status === 'valid-trusted');
    const originalUnresolved = [...verification.document, ...verification.revisions].some(s => ['key-unavailable', 'valid-untrusted'].includes(s.status));
    const rows: SignatureResult[] = [];
    for (const [kind, checks] of [['document', verification.document], ['form', verification.forms], ['revision', verification.revisions], ['seal', verification.seals]] as const)
        for (const source of checks) {
            const check: Check = malformed.has(`${kind}:${source.signatureId}`) && source.status === 'key-unavailable' ? { ...source, status: 'invalid-signature' } : source;
            const obsolete = kind === 'seal' && check.status === 'archive-changed' && hasCurrentSeal;
            const unresolvedBinding = check.status === 'wrong-revision' && kind !== 'document' && kind !== 'revision' && originalUnresolved;
            const outcome: SignatureResult['outcome'] = obsolete ? 'obsolete' : check.status === 'unsigned' ? 'unsigned' : check.status === 'valid-trusted' ? 'verified' : ['valid-untrusted', 'key-unavailable'].includes(check.status) || unresolvedBinding ? 'unverified' : 'failed';
            const [label, explanation] = statusText[check.status];
            rows.push({ ...check, kind, outcome, label: obsolete ? 'Superseded seal' : unresolvedBinding ? 'Original binding not verified' : label, explanation: obsolete ? 'A different trusted seal covers this snapshot. This earlier seal remains as an older snapshot record.' : unresolvedBinding ? 'A required original proof cannot be trusted with the available keys. Its dependent binding remains unverified.' : explanation, ...(!check.status.startsWith('valid-') ? { signer: undefined } : {}) });
        }
    return rows;
}
export async function validateDocument(buffer: ArrayBuffer, trust: TrustContext = emptyTrust(), progress: (phase: string) => void = () => { }): Promise<ValidationReport> {
    const report: ValidationReport = { specification: 'WDOC-FORMAT 1.0', checkedAt: new Date().toISOString(), verdict: 'invalid', format: 'invalid', documentDigest: null, rootPrefix: null, expandedBytes: 0, files: [], checks: [], recommendations: [], needsKeys: false, signatures: { state: 'not-checked', count: 0, results: [] }, trust: { source: trust.source, state: trust.state, ...(trust.detail ? { detail: trust.detail } : {}) } };
    progress('Checking ZIP records, paths, sizes, and CRCs…');
    let files: Files;
    try {
        const archive = await readDocumentArchive(buffer);
        files = archive.files;
        report.rootPrefix = archive.rootPrefix;
        report.files = Object.entries(files).map(([path, bytes]) => ({ path, size: bytes.length, kind: fileKind(path) })).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
        report.expandedBytes = report.files.reduce((sum, f) => sum + f.size, 0);
        report.checks.push(issue('zip', 'pass', 'ZIP container and limits', 'Headers, safe paths, unique entries, bounded expansion, actual sizes, and CRCs pass.', '4.1'));
        report.checks.push(issue('root', 'pass', 'One unambiguous document root', archive.rootPrefix ? `The single enclosing folder “${archive.rootPrefix}” resolves to logical document paths.` : 'index.html is at ZIP root. Resource subdirectories are allowed.', '4.4'));
        report.checks.push(issue('entry', 'pass', 'UTF-8 HTML entry point', 'index.html is present, readable UTF-8, and has no byte order mark.', '5.1', 'index.html'));
    }
    catch (error) {
        report.checks.push(issue('archive', 'error', 'Archive or entry point is invalid', message(error), '4'));
        return finish(report);
    }
    inspectHtml(decodeUtf8(files['index.html']!), report);
    for (const [path, bytes] of Object.entries(files)) {
        if (path !== 'index.html' && /\.(html?|css|svg)$/i.test(path)) {
            try {
                decodeUtf8(bytes);
            }
            catch (error) {
                report.checks.push(issue(`utf8:${path}`, 'error', 'Invalid UTF-8 text', message(error), '3.1', path));
            }
        }
        if (path.startsWith('wdoc-form/') && path.endsWith('.json')) {
            try {
                if (!isRecord(parseJson(decodeUtf8(bytes))))
                    throw new Error('Draft answers must be a JSON object.');
            }
            catch {
                report.recommendations.push(issue(`draft-json:${path}`, 'warning', 'Repair an unreadable editable draft', 'The viewer ignores malformed or non-object draft JSON. This file is not a signed answer snapshot.', '8.1', path));
            }
        }
    }
    if (!Object.hasOwn(files, 'manifest.json')) {
        report.signatures.state = 'unsigned';
        report.checks.push(issue('manifest', 'info', 'Manifest is optional', 'This is a valid unsigned base document. No document digest or authenticated file inventory is inferred.', '1.2'));
        report.recommendations.unshift(issue('manifest', 'warning', 'Add an integrity manifest', 'A complete manifest.json records metadata and the exact original file hashes. It prepares the document for signatures.', '6'));
        report.recommendations.push(issue('original-signature', 'warning', 'Sign the original document', 'A trusted document signature authenticates the original content and protected metadata.', '13'));
        report.recommendations.push(issue('seal', 'info', 'Seal the archive when it is complete', 'An optional final seal covers the supplied file membership, manifest bytes, submissions, and signatures.', '15'));
        const seals = report.files.filter(f => f.kind === 'seal');
        if (seals.length) {
            report.signatures.count = seals.filter(f => f.path.endsWith('.jws')).length;
            report.signatures.state = 'unverified';
            report.recommendations.push(issue('orphan-proofs', 'warning', 'Signature files need their manifest', 'Files in seals/ cannot be bound to an original without its manifest. They are not authenticated by this base document.', '17.1'));
        }
        return finish(report);
    }
    progress('Validating the manifest and file inventories…');
    let manifest: Manifest;
    try {
        const value: unknown = parseJson(decodeUtf8(files['manifest.json']!));
        if (!validateManifest(value))
            throw new Error(schemaMessage(validateManifest.errors));
        assertManifest(value);
        manifest = value;
        report.checks.push(issue('manifest', 'pass', 'Manifest schema and structure', 'Version 1.0, required members, types, dates, paths, IDs, nonce wrappers, and declared extension boundaries pass.', '6', 'manifest.json'));
    }
    catch (error) {
        report.checks.push(issue('manifest', 'error', 'Manifest is invalid', message(error), '6', 'manifest.json'));
        return finish(report);
    }
    report.signatures.count = manifest.signatures.document.length + manifest.signatures.forms.length + manifest.runtime.revisions.reduce((sum, r) => sum + r.signatures.length, 0) + report.files.filter(f => /^seals\/[^/]+\.jws$/.test(f.path)).length;
    report.needsKeys = report.signatures.count > 0;
    let originalOK = await inspectInventory(manifest, files, report);
    for (const path of Object.keys(files))
        if (path !== 'manifest.json' && !runtimePath(path) && !Object.hasOwn(manifest.content.files, path)) {
            originalOK = false;
            report.checks.push(issue(`unlisted:${path}`, 'error', 'An original is absent from the inventory', 'content.files must enumerate every original, including safe metadata files.', '7', path));
        }
    if (originalOK)
        report.checks.push(issue('inventory', 'pass', 'Original file membership and hashes', 'Every original exists, no original is omitted, and every SHA-256 hash matches its actual bytes.', '7'));
    if (dependenciesValid(manifest, files))
        report.checks.push(issue('resources', 'pass', 'Static rendering resources', 'Original HTML, SVG, and CSS satisfy the self-contained static integrity profile.', '5.5'));
    else
        report.checks.push(issue('resources', 'error', 'Static rendering profile failed', 'Original HTML/CSS may reference missing, external, active, unsupported, or unprotected resources. See the static dependency rules.', '5.5'));
    const knownDigests = new Set([await documentDigest(manifest)]);
    for (const revision of manifest.runtime.revisions) {
        const digest = await documentDigest(revision.scope);
        knownDigests.add(digest);
        const source: Files = Object.create(null);
        for (const [original, archived] of Object.entries(revision.files))
            if (files[archived])
                source[original] = files[archived]!;
        await inspectInventory(revision.scope, source, report, `revisions/${digest}/files/`);
        if (!dependenciesValid(revision.scope, source))
            report.checks.push(issue(`revision-resources:${digest}`, 'error', 'Archived revision dependencies failed', 'Every historical original must retain its own protected static resources.', '10', `revisions/${digest}/`));
    }
    let snapshotsOK = true;
    for (const [formId, submissions] of Object.entries(manifest.runtime.submissions))
        for (const submission of submissions) {
            if (!knownDigests.has(submission.documentDigest)) {
                snapshotsOK = false;
                report.checks.push(issue(`scope:${submission.submissionId}`, 'error', 'Submission references an absent scope', 'documentDigest must refer to the current or an archived original scope.', '9.1', submission.answersFile));
            }
            for (const path of [submission.answersFile, ...submission.attachments])
                if (!Object.hasOwn(files, path)) {
                    snapshotsOK = false;
                    report.checks.push(issue(`snapshot:${path}`, 'error', 'A submission file is missing', `This file is declared by submission ${submission.submissionId} for form ${formId}.`, '9.1', path));
                }
            for (const path of submission.attachments)
                if (/\.(html?|svg|js|mjs|cjs|exe|sh|bat|cmd)$/i.test(path)) {
                    snapshotsOK = false;
                    report.checks.push(issue(`attachment:${path}`, 'error', 'Unsupported submission attachment', 'The current producer profile prohibits executable HTML, SVG, JavaScript, and script attachment names.', '9.3', path));
                }
            if (files[submission.answersFile]) {
                try {
                    parseJson(decodeUtf8(files[submission.answersFile]!));
                }
                catch (error) {
                    snapshotsOK = false;
                    report.checks.push(issue(`answers:${submission.submissionId}`, 'error', 'Submission answers are not valid JSON', message(error), '9.2', submission.answersFile));
                }
            }
        }
    if (snapshotsOK && Object.keys(manifest.runtime.submissions).length)
        report.checks.push(issue('snapshots', 'pass', 'Immutable submission files', 'Declared answer and attachment files exist, answer JSON parses, and referenced scopes exist.', '9'));
    for (const [section, draft] of Object.entries(manifest.runtime.forms ?? {})) {
        const inventory = (draft as {
            files: Record<string, string>;
        }).files;
        for (const [path, expected] of Object.entries(inventory))
            if (!files[path] || await sha256(files[path]!) !== expected)
                report.recommendations.push(issue(`draft:${section}:${path}`, 'warning', 'Refresh an editable draft inventory', 'Draft inventory bytes are missing or changed. Draft metadata is outside the original signature scope.', '8.2', path));
    }
    const malformed = new Set<string>();
    const inspectJws = (kind: SignatureKind, id: string, text: string, path: string) => {
        const context = kind === 'revision' ? 'document' : kind;
        try {
            const segments = text.split('.');
            if (segments.length !== 3 || decodeBase64url(segments[2]!).length !== 64)
                throw new Error('ES256 requires a compact JWS with a 64-byte signature.');
            const header = parseJson(decodeUtf8(decodeBase64url(segments[0]!)));
            if (!validateHeader(header))
                throw new Error(schemaMessage(validateHeader.errors));
            if (header['typ'] !== `wdoc-${context}+jws`)
                throw new Error('Protected typ does not match this signature context.');
            const payloadText = decodeUtf8(decodeBase64url(segments[1]!)), payload: unknown = parseJson(payloadText);
            const validate = ajv.getSchema(schemaBase + `${context}-jws.schema.json`)!;
            if (!validate(payload))
                throw new Error(schemaMessage(validate.errors));
            assertPayload(payload, context);
            if (payloadText !== jcs(payload))
                report.recommendations.push(issue(`jcs:${kind}:${id}`, 'warning', 'Use canonical JSON when signing', 'Readers can verify these exact signed bytes, but producers must emit JCS payload JSON.', '11.1', path));
        }
        catch (error) {
            malformed.add(`${kind}:${id}`);
            report.checks.push(issue(`jws:${kind}:${id}`, 'error', 'Signature encoding or payload is invalid', message(error), '11', path));
        }
    };
    for (const signature of manifest.signatures.document)
        inspectJws('document', signature.signatureId, signature.jws, 'manifest.json');
    for (const signature of manifest.signatures.forms)
        inspectJws('form', signature.signatureId, signature.jws, 'manifest.json');
    for (const revision of manifest.runtime.revisions)
        for (const signature of revision.signatures)
            inspectJws('revision', signature.signatureId, signature.jws, 'manifest.json');
    for (const file of report.files.filter(f => f.kind === 'seal')) {
        const match = /^seals\/([A-Za-z0-9_-]{1,128})\.(jws|nonce)$/.exec(file.path);
        if (!match || !isIdentifier(match[1])) {
            report.checks.push(issue(`seal-path:${file.path}`, 'error', 'Invalid seal path', 'Seal files must have safe signature IDs and .jws or .nonce extensions.', '15.1', file.path));
            continue;
        }
        const partner = `seals/${match[1]}.${match[2] === 'jws' ? 'nonce' : 'jws'}`;
        if (!files[partner])
            report.checks.push(issue(`seal-pair:${file.path}`, 'error', 'Seal pair is incomplete', `The matching file ${partner} is required.`, '15.1', file.path));
        try {
            const text = decodeUtf8(files[file.path]!);
            if (match[2] === 'jws')
                inspectJws('seal', file.path, text, file.path);
            else if (!isDigest(text))
                throw new Error('A local seal nonce must be canonical base64url for 32 bytes, without whitespace.');
        }
        catch (error) {
            report.checks.push(issue(`seal-text:${file.path}`, 'error', 'Invalid seal file', message(error), '15.1', file.path));
        }
    }
    if (report.signatures.count)
        for (const file of report.files)
            if (/\.(js|mjs|cjs|exe|sh|bat|cmd)$/i.test(file.path))
                report.checks.push(issue(`executable:${file.path}`, 'error', 'Unsupported signed archive file', 'Signature producers must not introduce executable file names in this profile.', '4.3', file.path));
    progress('Verifying ES256 signatures, commitments, revisions, and seals…');
    try {
        const verification = await verifyDocument(manifest, files, trust.keys);
        report.documentDigest = verification.documentDigest;
        report.signatures.results = signatureResults(verification, malformed);
        const actual = report.signatures.results.filter(r => r.status !== 'unsigned');
        report.signatures.state = !report.signatures.count ? 'unsigned' : actual.some(r => r.outcome === 'failed') ? 'invalid' : actual.some(r => r.outcome === 'unverified') ? 'unverified' : 'verified';
        report.checks.push(issue('references', 'pass', 'Manifest cross-references', 'Revision digests and locations, complete original mappings, and signature ID uniqueness pass.', '10'));
        if (verification.content.status === 'file-modified' && !report.checks.some(c => c.level === 'error'))
            report.checks.push(issue('integrity', 'error', 'Original integrity failed', 'The full file map does not satisfy the original inventory or reserved namespace rules.', '7'));
        if (verification.forms.some(c => c.status === 'unsigned'))
            report.recommendations.push(issue('unsigned-submissions', 'warning', 'Sign the unsigned submissions', 'One or more immutable submissions have no form signature. A document signature does not sign their answers.', '14'));
        if (report.signatures.state === 'unverified')
            report.recommendations.push(issue('verification-keys', 'warning', 'Resolve signature trust', trust.detail ?? 'Provide an independently trusted registry containing the required public keys. Missing keys do not prove a signature is invalid.', '11.3'));
    }
    catch (error) {
        report.checks.push(issue('references', 'error', 'Manifest relationships are invalid', message(error), '10'));
        if (report.signatures.count)
            report.signatures.state = 'invalid';
    }
    if (!manifest.signatures.document.length)
        report.recommendations.unshift(issue('original-signature', 'warning', 'Sign the current original document', 'A matching inventory alone does not authenticate the document or its author.', '13'));
    if (!report.files.some(f => /^seals\/[^/]+\.jws$/.test(f.path)))
        report.recommendations.push(issue('seal', 'info', 'Add a final archive seal', 'A seal covers the supplied snapshot, including actual manifest bytes, runtime files, and signature membership.', '15'));
    report.recommendations.push(issue('retention', 'info', 'Keep the verified file', 'Seals verify the supplied snapshot. Detecting rollback or deletion of the newest seal requires an independently retained reference.', '15.3'));
    return finish(report);
}
