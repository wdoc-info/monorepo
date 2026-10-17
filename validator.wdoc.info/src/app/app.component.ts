import { ChangeDetectionStrategy, Component, computed, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import type { SignatureKind, ValidationReport } from './validation/validate-document';
import { emptyTrust, loadOnlineRegistry, parseRegistry, type TrustContext } from './validation/verification-keys';
@Component({
    selector: 'wdoc-validator', standalone: true, imports: [DatePipe], changeDetection: ChangeDetectionStrategy.OnPush,
    templateUrl: './app.component.html',
})
export class AppComponent {
    readonly file = signal<File | null>(null);
    readonly report = signal<ValidationReport | null>(null);
    readonly busy = signal(false);
    readonly phase = signal('Reading the document…');
    readonly error = signal('');
    readonly dragging = signal(false);
    readonly keyMode = signal<'online' | 'local'>('online');
    readonly registryName = signal('');
    readonly registryError = signal('');
    readonly registryLoading = signal(false);
    readonly keyCount = signal(0);
    readonly errorCount = computed(() => this.report()?.checks.filter(c => c.level === 'error').length ?? 0);
    readonly passedCount = computed(() => this.report()?.checks.filter(c => c.level === 'pass').length ?? 0);
    readonly adviceCount = computed(() => this.report()?.recommendations.length ?? 0);
    readonly groups = computed(() => {
        const rows = this.report()?.signatures.results ?? [];
        return ([['document', 'Current original'], ['form', 'Form submissions'], ['revision', 'Archived originals'], ['seal', 'Archive seals']] as const)
            .map(([kind, label]) => ({ kind, label, rows: rows.filter(r => r.kind === kind) })).filter(g => g.rows.length);
    });
    private epoch = 0;
    private registryEpoch = 0;
    private dragDepth = 0;
    private worker?: Worker;
    private rejectWorker?: (reason: unknown) => void;
    private request?: AbortController;
    private localTrust: TrustContext | null = null;
    chooseDocument(event: Event) {
        const input = event.target as HTMLInputElement;
        const files = Array.from(input.files ?? []);
        input.value = '';
        this.acceptFiles(files);
    }
    dragEnter(event: DragEvent) { event.preventDefault(); this.dragDepth++; this.dragging.set(true); }
    dragOver(event: DragEvent) { event.preventDefault(); if (event.dataTransfer)
        event.dataTransfer.dropEffect = 'copy'; }
    dragLeave(event: DragEvent) { event.preventDefault(); if (--this.dragDepth <= 0) {
        this.dragDepth = 0;
        this.dragging.set(false);
    } }
    drop(event: DragEvent) { event.preventDefault(); this.dragDepth = 0; this.dragging.set(false); this.acceptFiles(Array.from(event.dataTransfer?.files ?? [])); }
    private acceptFiles(files: File[]) {
        if (!files.length)
            return;
        if (files.length !== 1) {
            this.clear();
            this.error.set('Choose one document at a time.');
            return;
        }
        this.file.set(files[0]!);
        void this.run();
    }
    clear() {
        this.epoch++;
        this.stopWorker();
        this.request?.abort();
        this.busy.set(false);
        this.report.set(null);
        this.file.set(null);
        this.error.set('');
    }
    setKeyMode(mode: 'online' | 'local') {
        if (this.keyMode() === mode)
            return;
        this.keyMode.set(mode);
        if (this.file())
            void this.run();
    }
    async chooseRegistry(event: Event) {
        const input = event.target as HTMLInputElement, file = input.files?.[0];
        input.value = '';
        if (!file)
            return;
        const id = ++this.registryEpoch;
        this.epoch++;
        this.stopWorker();
        this.request?.abort();
        this.busy.set(false);
        this.report.set(null);
        this.keyMode.set('local');
        this.localTrust = null;
        this.keyCount.set(0);
        this.registryName.set(file.name);
        this.registryError.set('');
        this.registryLoading.set(true);
        try {
            if (file.size > 1000000)
                throw new Error('Public key registries are limited to 1 MB in this validator.');
            const trust = await parseRegistry(new Uint8Array(await file.arrayBuffer()), file.name, 'local');
            if (id !== this.registryEpoch)
                return;
            this.localTrust = trust;
            this.keyCount.set(trust.keys.length);
        }
        catch (error) {
            if (id !== this.registryEpoch)
                return;
            this.registryError.set(error instanceof Error ? error.message : 'The public key registry could not be read.');
        }
        finally {
            if (id === this.registryEpoch) {
                this.registryLoading.set(false);
                if (this.file())
                    void this.run();
            }
        }
    }
    async run() {
        const file = this.file();
        if (!file || this.registryLoading())
            return;
        const id = ++this.epoch;
        this.stopWorker();
        this.request?.abort();
        this.request = new AbortController();
        this.busy.set(true);
        this.report.set(null);
        this.error.set('');
        this.phase.set('Reading the document…');
        try {
            let trust = this.keyMode() === 'local' ? this.localTrust ?? emptyTrust(this.registryError() || 'Load an independently trusted local public key registry to verify signatures.') : emptyTrust();
            let result = await this.analyze(await file.arrayBuffer(), trust, id);
            if (id !== this.epoch)
                return;
            if (result.needsKeys && this.keyMode() === 'online') {
                this.phase.set('Retrieving public verification keys. Your document stays here…');
                try {
                    trust = await loadOnlineRegistry(this.request.signal);
                }
                catch {
                    trust = { state: 'unavailable', source: 'Configured wdoc authority', keys: [], detail: 'The public key registry could not be reached or did not pass policy checks. Load a trusted local registry or try again. No document data was sent.' };
                }
                if (id !== this.epoch)
                    return;
                result = await this.analyze(await file.arrayBuffer(), trust, id);
            }
            if (id === this.epoch)
                this.report.set(result);
        }
        catch (error) {
            if (id === this.epoch)
                this.error.set(error instanceof Error ? error.message : 'Validation could not finish. Please try again.');
        }
        finally {
            if (id === this.epoch)
                this.busy.set(false);
        }
    }
    private analyze(buffer: ArrayBuffer, trust: TrustContext, id: number): Promise<ValidationReport> {
        this.stopWorker();
        return new Promise((resolve, reject) => {
            const worker = new Worker(new URL('./validation/validation.worker', import.meta.url), { type: 'module' });
            this.worker = worker;
            this.rejectWorker = reject;
            const complete = () => { worker.terminate(); if (this.worker === worker) {
                this.worker = undefined;
                this.rejectWorker = undefined;
            } };
            worker.onmessage = ({ data }: MessageEvent<{
                id: number;
                phase?: string;
                report?: ValidationReport;
                error?: string;
            }>) => {
                if (data.id !== this.epoch) {
                    complete();
                    reject(new Error('Validation cancelled.'));
                    return;
                }
                if (data.phase)
                    this.phase.set(data.phase);
                if (data.report) {
                    complete();
                    resolve(data.report);
                }
                if (data.error) {
                    complete();
                    reject(new Error(data.error));
                }
            };
            worker.onerror = () => { complete(); reject(new Error('The local validation worker could not finish. Please reload and try again.')); };
            worker.postMessage({ id, buffer, trust }, [buffer]);
        });
    }
    private stopWorker() {
        this.worker?.terminate();
        this.worker = undefined;
        const reject = this.rejectWorker;
        this.rejectWorker = undefined;
        reject?.(new Error('Validation cancelled.'));
    }
    bytes(value: number): string {
        return value < 1000 ? `${value} B` : value < 1000000 ? `${(value / 1000).toFixed(value < 10000 ? 1 : 0)} kB` : `${(value / 1000000).toFixed(2)} MB`;
    }
    title(report: ValidationReport): string {
        if (report.format === 'invalid')
            return 'This file does not conform.';
        if (report.signatures.state === 'invalid')
            return 'A signature check failed.';
        if (report.signatures.state === 'unverified')
            return 'Valid format. Verification incomplete.';
        return report.signatures.state === 'unsigned' ? 'Valid, unsigned wdoc.' : 'Format and signatures verified.';
    }
    description(report: ValidationReport): string {
        if (report.format === 'invalid')
            return 'Review the failed format checks below. Optional improvements never make an unsigned document invalid.';
        if (report.signatures.state === 'invalid')
            return 'The container is well formed, but one or more signatures or protected scopes did not verify.';
        if (report.signatures.state === 'unverified')
            return 'The format passes. Some signature checks need trusted public keys before a conclusion can be reached.';
        return report.signatures.state === 'unsigned' ? 'The required structure passes. A manifest and signatures are optional; see the suggestions below.' : 'All present signatures verify under the selected key policy. Review each scope and the optional improvements below.';
    }
    signatureLabel(state: ValidationReport['signatures']['state']): string { return ({ 'not-checked': 'Not checked', unsigned: 'None present', verified: 'Present signatures verified', unverified: 'Not fully verified', invalid: 'Verification failed' })[state]; }
    signer(value: unknown): string { return isSigner(value) ? value.displayName || value.userId : ''; }
    kindLabel(kind: SignatureKind): string { return ({ document: 'Original', form: 'Form', revision: 'Revision', seal: 'Seal' })[kind]; }
    exportReport() {
        const report = this.report(), file = this.file();
        if (!report || !file)
            return;
        const url = URL.createObjectURL(new Blob([JSON.stringify({ file: { name: file.name, size: file.size }, ...report }, null, 2) + '\n'], { type: 'application/json' }));
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = 'wdoc-validation-report.json';
        anchor.click();
        setTimeout(() => URL.revokeObjectURL(url), 0);
    }
}
function isSigner(value: unknown): value is {
    displayName: string;
    userId: string;
} { return !!value && typeof value === 'object' && 'displayName' in value && typeof value.displayName === 'string' && 'userId' in value && typeof value.userId === 'string'; }
