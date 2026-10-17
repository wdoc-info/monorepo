import { validateDocument } from './validate-document';
import type { TrustContext } from './verification-keys';
addEventListener('message', async ({ data }: MessageEvent<{
    id: number;
    buffer: ArrayBuffer;
    trust: TrustContext;
}>) => {
    try {
        const report = await validateDocument(data.buffer, data.trust, phase => postMessage({ id: data.id, phase }));
        postMessage({ id: data.id, report });
    }
    catch {
        postMessage({ id: data.id, error: 'Validation could not finish. The document was not uploaded. Please try a smaller file or another browser.' });
    }
});
