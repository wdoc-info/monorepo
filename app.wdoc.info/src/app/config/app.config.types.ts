export interface BackendConfig {
  authApiUrl: string;
  signingKeyOrigins: string[];
}

export interface AppConfig {
  version: string;
  backend: BackendConfig;
}
