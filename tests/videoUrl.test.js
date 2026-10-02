import { describe, it, expect } from 'vitest';
import { canonicalVideoUrl, videoThumbnailUrl } from '../src/services/videoUrl.js';

describe('product video links', () => {
  const ID = 'dQw4w9WgXcQ';
  const CANON = `https://www.youtube.com/watch?v=${ID}`;

  it('accepts the shapes people actually paste', () => {
    for (const url of [
      CANON,
      `https://youtu.be/${ID}`,
      `https://www.youtube.com/embed/${ID}?rel=0`,
      `https://www.youtube.com/shorts/${ID}`,
      `https://m.youtube.com/watch?v=${ID}&t=30s`,
      `https://youtube-nocookie.com/embed/${ID}`,
    ]) {
      expect(canonicalVideoUrl(url), url).toBe(CANON);
    }
  });

  it('refuses anything that is not a YouTube video', () => {
    for (const url of [
      'https://vimeo.com/123456789',
      'javascript:alert(1)',
      'file:///etc/passwd',
      'https://youtube.com/watch?v=short',
      'https://evil.com/watch?v=dQw4w9WgXcQ',
      'not a url',
      '',
      null,
      undefined,
      42,
    ]) {
      expect(canonicalVideoUrl(url), String(url)).toBeNull();
    }
  });

  it('derives the thumbnail from the id', () => {
    expect(videoThumbnailUrl(`https://youtu.be/${ID}`)).toBe(`https://i.ytimg.com/vi/${ID}/hqdefault.jpg`);
    expect(videoThumbnailUrl(null)).toBeNull();
    expect(videoThumbnailUrl('https://vimeo.com/1')).toBeNull();
  });
});
