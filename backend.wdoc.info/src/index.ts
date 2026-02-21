import { createApp } from "./app";
import { loadConfig } from "./config";

const config = loadConfig();
const app = createApp({ config });

console.log(`wdoc auth API listening on :${config.port}`);

export default {
  port: config.port,
  fetch: app.fetch,
};
