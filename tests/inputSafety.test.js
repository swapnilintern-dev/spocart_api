import { describe, it, expect } from 'vitest';
import { plainText, fileUrl } from '../src/routes/_schemas.js';

describe('plainText', () => {
  const name = plainText(20, 2, 'Name is required');

  it('accepts ordinary text, including a bare "<"', () => {
    expect(name.parse('  Ravi Sports  ')).toBe('Ravi Sports');
    expect(plainText(50).parse('Need <50 pcs & a quote')).toBe('Need <50 pcs & a quote');
  });

  it('refuses anything tag-like', () => {
    for (const bad of ['<img src=x onerror=alert(1)>', '<script>', '</b>', '<!-- x', '< svg onload=1>']) {
      expect(plainText(100).safeParse(bad).success).toBe(false);
    }
  });

  it('enforces the length limits', () => {
    expect(name.safeParse('A').success).toBe(false);
    expect(name.safeParse('x'.repeat(21)).success).toBe(false);
  });
});

describe('fileUrl', () => {
  it('allows our uploads and http(s) links', () => {
    expect(fileUrl.parse('/uploads/designs/a.csv')).toBe('/uploads/designs/a.csv');
    expect(fileUrl.parse('https://res.cloudinary.com/x/raw/upload/a.pdf')).toMatch(/^https:/);
  });

  it('refuses script and data links', () => {
    for (const bad of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,<b>', '//evil.example/x']) {
      expect(fileUrl.safeParse(bad).success).toBe(false);
    }
  });
});
