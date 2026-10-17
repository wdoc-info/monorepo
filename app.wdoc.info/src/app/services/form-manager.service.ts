import { Injectable } from '@angular/core';
import JSZip from 'jszip';
import { assertFiles, assertManifest, decodeUtf8, isIdentifier, isRecord, parseJson, verifyDocument, safePath } from '../signatures/core';
import { readDocumentArchive } from '../signatures/archive';
import { APP_VERSION } from '../config/app.config';
import {
  generateManifest,
  serializeManifest,
} from './manifest-builder';
import { AuthService } from './auth.service';
import { type ZipContainer } from './zip-reader';

@Injectable({ providedIn: 'root' })
export class FormManagerService {
  constructor(private authService: AuthService) {}

  async populateFormsFromZip(
    zip: ZipContainer,
    doc: Document,
    basePath = '',
  ): Promise<void> {
    const formsFolder = zip.folder(`${basePath}wdoc-form`);
    if (!formsFolder) {
      return;
    }

    const formElements = Array.from(doc.querySelectorAll('form'));

    const entries = formsFolder.filter((path) => path.endsWith('.json'));
    const root: string | undefined = (formsFolder as any).root;
    for (const entry of entries) {
      const relativeName =
        root && entry.name.startsWith(root) ? entry.name.slice(root.length) : entry.name;
      let data: Record<string, string>;
      try {
        data = parseJson(decodeUtf8(await entry.async('uint8array') as Uint8Array));
        if (!isRecord(data)) continue;
      } catch {
        continue;
      }

      const base = relativeName.replace(/\.json$/, '');
      const named = doc.getElementById(base);
      let form = named instanceof HTMLFormElement ? named : null;
      const position = /^form-([1-9][0-9]*)$/.exec(base);
      if (!form && position) form = formElements[Number(position[1]) - 1] ?? null;
      if (!form) {
        continue;
      }

      for (const [key, value] of Object.entries(data)) {
        const control = Array.from(form.elements).find(el => el.getAttribute('name') === key) as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | undefined;
        if (!control) {
          continue;
        }
        if (control instanceof HTMLInputElement && control.type === 'file') {
          const removeExistingLink = () => {
            const sibling = control.nextElementSibling;
            if (
              sibling instanceof HTMLAnchorElement &&
              sibling.dataset['wdocFileLink'] === 'true'
            ) {
              sibling.remove();
            }
          };

          control.addEventListener('change', removeExistingLink);

          if (typeof value === 'string' && safePath(value) && !value.includes('/')) {
            const fileEntry = formsFolder.file(value);
            if (fileEntry) {
              const mime = this.guessMimeType(value);
              const buffer = (await fileEntry.async('arraybuffer')) as ArrayBuffer;
              const blob = new Blob([buffer], mime ? { type: mime } : undefined);
              const url = URL.createObjectURL(blob);
              const link = doc.createElement('a');
              link.href = url;
              link.textContent = value;
              link.target = '_blank';
              link.download = value;
              link.dataset['wdocFileLink'] = 'true';
              control.insertAdjacentElement('afterend', link);
              control.dataset['savedFile'] = value;
            }
          }
        } else if (control instanceof HTMLInputElement && control.type === 'checkbox') {
          control.checked = value === 'true' || value === 'on' || value === '1';
        } else if (control instanceof HTMLInputElement && control.type === 'radio') {
          const radioGroup = Array.from(form.querySelectorAll<HTMLInputElement>('input[type="radio"]')).filter(r => r.name === key);
          radioGroup.forEach((radio) => {
            radio.checked = radio.value === value;
          });
        } else if ('value' in control) {
          const strValue = String(value ?? '');
          control.value = strValue;
          if (control instanceof HTMLTextAreaElement) {
            control.textContent = strValue;
          } else {
            control.setAttribute('value', strValue);
          }
        }
      }
    }
  }

  async saveForms(
    formRoot: Document | ShadowRoot | HTMLElement,
    originalArrayBuffer: ArrayBuffer,
  ): Promise<boolean> {
    const forms = Array.from(formRoot.querySelectorAll('form'));
    for (const form of forms) {
      if (!this.isFormValid(form)) {
        return false;
      }
    }

    const {zip: newZip, files} = await readDocumentArchive(originalArrayBuffer);
    if (files['manifest.json']) {
      const existing = parseJson(decodeUtf8(files['manifest.json']));
      assertManifest(existing);
      if ((await verifyDocument(existing, files, [])).content.status === 'file-modified') throw new Error('Original signed content was modified.');
    }
    const names = forms.map((form, index) => {
      if (form.id && !isIdentifier(form.id)) throw new Error('Unsafe form ID.');
      return `${form.id || `form-${index + 1}`}.json`;
    });
    if (new Set(names).size !== names.length) throw new Error('Ambiguous draft form IDs.');
    const formsFolder = newZip.folder('wdoc-form');
    const attachmentNames = new Set<string>();
    for (const [index, form] of forms.entries()) {
      const fd = new FormData(form as HTMLFormElement);
      const data: Record<string, unknown> = Object.create(null);
      for (const [key, value] of fd.entries()) {
        if (typeof value === 'string') {
          data[key] = value;
        } else {
          const input = Array.from(form.querySelectorAll<HTMLInputElement>('input[type="file"]')).find(el => el.name === key);
          const file = input?.files?.[0] as File | undefined;
          const existingFileName = input?.dataset['savedFile'];
          if (existingFileName && (!safePath(existingFileName) || existingFileName.includes('/'))) throw new Error('Unsafe saved attachment name.');
          if (file && file.name) {
            if (!safePath(file.name) || file.name.includes('/')) throw new Error('Unsafe attachment name.');
            if (file.size > 10_000_000) throw new Error('Attachment exceeds archive limits.');
            if (names.includes(file.name) || attachmentNames.has(file.name)) throw new Error('Conflicting draft attachment name.');
            attachmentNames.add(file.name);
            if (existingFileName && existingFileName !== file.name) {
              formsFolder?.remove(existingFileName);
              newZip.remove(`wdoc-form/${existingFileName}`);
            }
            data[key] = file.name;
            const buf = await file.arrayBuffer();
            formsFolder?.file(file.name, buf, { binary: true });
            if (input) {
              input.dataset['savedFile'] = file.name;
            }
          } else {
            data[key] = existingFileName ?? '';
          }
        }
      }
      formsFolder?.file(names[index]!, JSON.stringify(data));
    }
    await this.addManifest(newZip);
    if (Object.keys(newZip.files).length > 1000) throw new Error('Too many archive entries.');
    const output: Record<string, Uint8Array> = Object.create(null);
    for (const entry of Object.values(newZip.files)) if (!entry.dir) output[entry.name] = await entry.async('uint8array');
    assertFiles(output);
    const blob = await newZip.generateAsync({ type: 'blob' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'filled.wdoc';
    a.click();
    URL.revokeObjectURL(a.href);
    return true;
  }

  private isFormValid(form: HTMLFormElement): boolean {
    if (typeof form.reportValidity === 'function') {
      return form.reportValidity();
    }
    if (typeof form.checkValidity === 'function') {
      return form.checkValidity();
    }
    return true;
  }

  private async addContentManifest(zip: JSZip): Promise<void> {
    await this.addManifest(zip);
  }

  private async addManifest(zip: JSZip): Promise<void> {
    const existing = zip.file('manifest.json');
    if (existing) {
      const parsed = parseJson(decodeUtf8(await existing.async('uint8array')));
      assertManifest(parsed);
      // Draft changes preserve the protected scope and immutable submissions.
      const drafts = await generateManifest(zip);
      parsed.runtime.forms = drafts.runtime.forms;
      parsed.runtime.updatedAt = new Date().toISOString();
      zip.file('manifest.json', serializeManifest(parsed));
      return;
    }
    const creator = this.authService.getCurrentUserEmail();
    const manifest = await generateManifest(zip, {
      appVersion: APP_VERSION,
      ...(creator ? { creator } : {}),
    });
    zip.file('manifest.json', serializeManifest(manifest));
  }

  private guessMimeType(name: string): string | undefined {
    const ext = name.split('.').pop()?.toLowerCase();
    switch (ext) {
      case 'png':
        return 'image/png';
      case 'jpg':
      case 'jpeg':
        return 'image/jpeg';
      case 'gif':
        return 'image/gif';
      case 'pdf':
        return 'application/pdf';
      case 'txt':
        return 'text/plain';
      default:
        return undefined;
    }
  }
}
