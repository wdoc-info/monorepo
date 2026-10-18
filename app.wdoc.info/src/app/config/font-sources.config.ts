/** Network permissions for font files and font-only stylesheets, in every build. */
export const DEFAULT_FONT_SOURCES = [
  { origin: 'https://fonts.googleapis.com', paths: ['/css', '/css2'], exact: true },
  { origin: 'https://fonts.gstatic.com', paths: ['/s/'], exact: false },
  { origin: 'https://fonts.bunny.net', paths: ['/'], exact: false },
  { origin: 'https://cdn.jsdelivr.net', paths: ['/fontsource/css/', '/fontsource/fonts/'], exact: false },
] as const;
