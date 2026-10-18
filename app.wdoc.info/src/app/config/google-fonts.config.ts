import { GOOGLE_FONT_CATALOG } from './google-fonts.catalog';

export interface GoogleFont {
  family: string;
  styles: string;
}

export const GOOGLE_FONTS: readonly GoogleFont[] = GOOGLE_FONT_CATALOG.map(
  ([family, styles]) => ({ family, styles }),
);

/** CSS2 accepts explicit, sorted italic/weight tuples, including single-weight families. */
export function googleFontStylesheet(font: GoogleFont): string {
  const url = new URL('https://fonts.googleapis.com/css2');
  url.searchParams.set('family', `${font.family}:ital,wght@${font.styles}`);
  url.searchParams.set('display', 'swap');
  return url.href;
}
