import { GOOGLE_FONTS, googleFontStylesheet } from './google-fonts.config';
import { externalFontUrl } from '../signatures/core';

describe('Google Fonts catalog', () => {
  it('ships a searchable catalog without requiring an API key or catalog request', () => {
    expect(GOOGLE_FONTS.length).toBeGreaterThan(1000);
    expect(new Set(GOOGLE_FONTS.map(font => font.family)).size).toBe(GOOGLE_FONTS.length);
    expect(GOOGLE_FONTS.some(font => font.family === 'JetBrains Mono')).toBeTrue();
  });

  it('requests available regular, bold, and italic styles with a canonical HTTPS URL', () => {
    const url = googleFontStylesheet(GOOGLE_FONTS.find(font => font.family === 'Inter')!);
    expect(externalFontUrl(url)).toBeTrue();
    expect(new URL(url).searchParams.get('family')).toBe('Inter:ital,wght@0,400;0,700;1,400;1,700');
    expect(new URL(url).searchParams.get('display')).toBe('swap');
  });

  it('handles single-weight families and families without weight 400', () => {
    for (const [family, styles] of [['Pacifico', '0,400'], ['Buda', '0,300'], ['UnifrakturCook', '0,700']]) {
      const url = googleFontStylesheet(GOOGLE_FONTS.find(font => font.family === family)!);
      expect(new URL(url).searchParams.get('family')).toBe(`${family}:ital,wght@${styles}`);
    }
  });
});
