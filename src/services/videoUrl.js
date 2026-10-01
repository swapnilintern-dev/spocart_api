// Product videos are official brand clips on YouTube. We store the canonical
// watch URL and derive the thumbnail from the id, so nothing else has to parse
// the link — and a link that is not a YouTube video is refused on write rather
// than failing silently on a buyer's phone.

/** Accepts the shapes people actually paste; returns the 11-character id. */
export function youtubeId(raw) {
  if (typeof raw !== 'string') return null;
  const url = raw.trim();
  if (!url) return null;

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;

  const host = parsed.hostname.replace(/^www\./, '').toLowerCase();
  const valid = (id) => (/^[A-Za-z0-9_-]{11}$/.test(id) ? id : null);

  if (host === 'youtu.be') return valid(parsed.pathname.slice(1));
  if (host !== 'youtube.com' && host !== 'm.youtube.com' && host !== 'youtube-nocookie.com') {
    return null;
  }
  if (parsed.pathname === '/watch') return valid(parsed.searchParams.get('v') ?? '');
  const path = parsed.pathname.match(/^\/(?:embed|shorts|v|live)\/([^/?#]+)/);
  return path ? valid(path[1]) : null;
}

/** Canonical watch URL for a pasted link, or null when it is not a video. */
export function canonicalVideoUrl(raw) {
  const id = youtubeId(raw);
  return id ? `https://www.youtube.com/watch?v=${id}` : null;
}

/** Still image for a stored video URL; null when there is no video. */
export function videoThumbnailUrl(storedUrl) {
  const id = youtubeId(storedUrl);
  return id ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : null;
}
