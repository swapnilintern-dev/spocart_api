// India Post PIN lookup, cached in our own table.
//
// The upstream service (api.postalpincode.in) is free and unauthenticated but
// slow and occasionally down, so every successful answer is stored and served
// from the database afterwards. A PIN we have never seen and cannot fetch is
// reported as unavailable — the buyer then types the city and state by hand,
// which the address form always allows.
import { prisma } from '../db/prisma.js';
import { ApiError } from '../middleware/error.js';

const UPSTREAM = 'https://api.postalpincode.in/pincode';
const TIMEOUT_MS = 4000;

/// Freshly fetched rows are trusted for a year: post offices move rarely, and a
/// stale city is better than a failed lookup.
const MAX_AGE_MS = 365 * 24 * 60 * 60_000;

const serialize = (row) => ({
  pincode: row.pincode,
  city: row.city,
  district: row.district,
  state: row.state,
});

/** Picks the most useful place name out of the post offices for a PIN. */
function placeFrom(offices) {
  const first = offices[0];
  // Block/Taluk is usually the town people would write; District is the safe
  // fallback, and both are present on virtually every record.
  const city = (first.Block && first.Block !== 'NA' ? first.Block : '') || first.District || '';
  return {
    city: String(city).trim(),
    district: String(first.District ?? '').trim(),
    state: String(first.State ?? '').trim(),
  };
}

/**
 * Asks India Post about one PIN.
 * Returns the place on success, `'unknown'` when the service answered that no
 * such PIN exists, or `null` when we could not get an answer at all. The two
 * failures are different: one is the buyer's typo, the other is our problem.
 */
async function fetchUpstream(pincode) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${UPSTREAM}/${pincode}`, { signal: controller.signal });
    if (!res.ok) return null;
    const body = await res.json();
    const entry = Array.isArray(body) ? body[0] : null;
    if (!entry) return null;

    const offices = entry.PostOffice;
    if (!Array.isArray(offices) || offices.length === 0) {
      // A well-formed "no records found" answer: the PIN does not exist.
      return entry.Status === 'Error' || entry.Status === 'Success' ? 'unknown' : null;
    }
    const place = placeFrom(offices);
    return place.city && place.state ? place : 'unknown';
  } catch {
    // Timeout, DNS failure, HTML instead of JSON — we have no answer.
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolves a 6-digit PIN to { pincode, city, district, state }.
 * Throws 404 when the PIN does not exist, and 503 when we have no cached copy
 * and the service could not be reached — the form then lets the buyer type the
 * city and state, so neither case blocks an address.
 */
export async function lookupPincode(pincode) {
  const cached = await prisma.pincode.findUnique({ where: { pincode } });
  if (cached && Date.now() - cached.fetchedAt.getTime() < MAX_AGE_MS) {
    return serialize(cached);
  }

  const fresh = await fetchUpstream(pincode);
  if (fresh === 'unknown') {
    throw new ApiError(404, 'We could not find that PIN code. Please check it.');
  }
  if (!fresh) {
    // A stale row still beats nothing when the upstream service is unavailable.
    if (cached) return serialize(cached);
    throw new ApiError(
      503,
      'PIN code lookup is unavailable right now. Please type your city and state.',
    );
  }

  const row = await prisma.pincode.upsert({
    where: { pincode },
    create: { pincode, ...fresh },
    update: { ...fresh, fetchedAt: new Date() },
  });
  return serialize(row);
}
