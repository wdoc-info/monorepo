/// <reference lib="webworker" />
import { GitEngine } from './git-engine';
const engine = new GitEngine();
let sequence = Promise.resolve();
addEventListener('message', ({ data }) => {
  sequence = sequence.then(async () => {
    try {
      let result: unknown;
      switch (data.method) {
        case 'open': result = await engine.open(data.files, data.session); break;
        case 'autosave': result = await engine.autosave(data.files); break;
        case 'publish': result = await engine.publish(data.files, data.other); break;
        case 'rollback': result = await engine.rollback(); break;
        case 'confirm': result = engine.confirm(); break;
        case 'snapshot': result = await engine.snapshot(data.oid); break;
        case 'import': result = await engine.importVersion(data.files); break;
        default: throw new Error('Unknown history operation');
      }
      postMessage({ id: data.id, result });
    } catch (error) { postMessage({ id: data.id, error: (error as Error).message }); }
  });
});
