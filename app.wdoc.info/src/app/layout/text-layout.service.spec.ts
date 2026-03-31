import { TestBed } from '@angular/core/testing';
import { TextLayoutService } from './text-layout.service';

describe('TextLayoutService', () => {
  let service: TextLayoutService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(TextLayoutService);
  });

  it('reuses prepared cache entries for repeated measurements', () => {
    service.measureText('hello world', '16px Arial', 20, 120, 'normal');
    service.measureText('hello world', '16px Arial', 20, 120, 'normal');

    expect((service as any).preparedCache.size).toBe(1);
  });

  it('supports pre-wrap hard breaks', () => {
    const result = service.measureText(
      'first line\nsecond line',
      '16px Arial',
      20,
      200,
      'pre-wrap',
    );

    expect(result.lineCount).toBe(2);
    expect(result.height).toBe(40);
  });

  it('clears caches when the locale changes', () => {
    service.measureText('bonjour', '16px Arial', 20, 120, 'normal');
    expect((service as any).preparedCache.size).toBe(1);

    service.setLocale('fr-FR');

    expect((service as any).preparedCache.size).toBe(0);
  });
});
