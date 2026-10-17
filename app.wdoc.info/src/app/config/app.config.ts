import { AppConfig } from './app.config.types';

export const APP_VERSION = '0.0.1';

export const appConfig: AppConfig = {
  version: APP_VERSION,
  backend: {
    signingKeyOrigins: ['https://sig.wdoc.info'],
    authApiUrl: 'http://localhost:3000',
  },
};

export const backendConfig = appConfig.backend;
