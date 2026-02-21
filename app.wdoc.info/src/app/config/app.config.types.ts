export interface BackendConfig {
  authApiUrl: string;
}

export interface AppConfig {
  version: string;
  backend: BackendConfig;
}
