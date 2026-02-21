import { AppConfig } from './app.config.types';

export const APP_VERSION = '0.0.1';

export const appConfig: AppConfig = {
  version: APP_VERSION,
  backend: {
    authApiUrl: 'https://backend.wdoc.info',
  },
};

export const backendConfig = appConfig.backend;
