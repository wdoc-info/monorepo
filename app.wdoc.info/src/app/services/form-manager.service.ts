import { Injectable } from '@angular/core';
import JSZip from 'jszip';
import { APP_VERSION } from '../config/app.config';
import {
  ManifestMetaOverrides,
  WdocManifest,
  generateManifest,
  serializeManifest,
} from './manifest-builder';
import { AuthService } from './auth.service';
import { type ZipContainer } from './zip-reader';

@Injectable({ providedIn: 'root' })
export class FormManagerService {
  constructor(private authService: AuthService) {}

  async populateFormsFromZip(zip: ZipContainer, doc: Document): Promise<void> {
    const formsFolder = zip.folder('wdoc-form');
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
        data = JSON.parse((await entry.async('text')) as string);
      } catch {
        continue;
      }

      const base = relativeName.replace(/\.json$/, '');
      let form: HTMLFormElement | null = null;
      if (base.startsWith('form-')) {
        const idx = parseInt(base.slice(5), 10) - 1;
        if (!isNaN(idx) && idx >= 0 && idx < formElements.length) {
          form = formElements[idx] as HTMLFormElement;
        }
      } else {
        form = doc.getElementById(base) as HTMLFormElement;
      }
      if (!form) {
        continue;
      }

      for (const [key, value] of Object.entries(data)) {
        const control = form.querySelector(`[name="${key}"]`) as
          | HTMLInputElement
          | HTMLSelectElement
          | HTMLTextAreaElement
          | null;
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

          if (typeof value === 'string' && value) {
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
          const radioGroup = form.querySelectorAll<HTMLInputElement>(
            `input[type="radio"][name="${key}"]`,
          );
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

    const newZip = await JSZip.loadAsync(originalArrayBuffer);
    const formsFolder = newZip.folder('wdoc-form');
    let idx = 1;
    for (const form of forms) {
      const fd = new FormData(form as HTMLFormElement);
      const data: Record<string, unknown> = {};
      for (const [key, value] of fd.entries()) {
        if (typeof value === 'string') {
          data[key] = value;
        } else {
          const input = form.querySelector(`[name="${key}"]`) as HTMLInputElement | null;
          const file = input?.files?.[0] as File | undefined;
          const existingFileName = input?.dataset['savedFile'];
          if (file && file.size > 0 && file.name) {
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
      const id = form.getAttribute('id');
      const name = id ? `${id}.json` : `form-${idx++}.json`;
      formsFolder?.file(name, JSON.stringify(data));
    }
    await this.addManifest(newZip);
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
    const manifestMeta = await this.extractExistingMeta(zip);
    const creator = this.authService.getCurrentUserEmail();
    const mergedMeta: ManifestMetaOverrides = {
      ...manifestMeta,
      appVersion: APP_VERSION,
    };
    if (creator) {
      mergedMeta.creator = creator;
    } else {
      delete mergedMeta.creator;
    }

    const manifest = await generateManifest(zip, mergedMeta);
    zip.remove('content_manifest.json');
    zip.file('manifest.json', serializeManifest(manifest));
  }

  private async extractExistingMeta(zip: JSZip): Promise<ManifestMetaOverrides> {
    const manifestFile = zip.file('manifest.json');
    if (!manifestFile) {
      return {};
    }

    try {
      const content = await manifestFile.async('text');
      const parsed = JSON.parse(content) as WdocManifest;
      return {
        docTitle: parsed.meta?.docTitle,
        creator: parsed.meta?.creator,
        appVersion: parsed.meta?.appVersion,
        creationDate: parsed.meta?.creationDate,
        docVersion: parsed.meta?.docVersion,
      } satisfies ManifestMetaOverrides;
    } catch {
      return {};
    }
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
