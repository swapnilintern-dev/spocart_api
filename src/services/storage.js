// File storage behind one function. Cloudinary in production (persistent,
// CDN-delivered, auto-optimised); local disk when Cloudinary is not configured
// so `npm run dev` keeps working without credentials.
//
// Folders: spocart/products · spocart/categories · spocart/quotes · spocart/documents
import { v2 as cloudinary } from 'cloudinary';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { env } from '../config/env.js';
import { ApiError } from '../middleware/error.js';

export const usingCloudinary = Boolean(env.CLOUDINARY_CLOUD_NAME && env.CLOUDINARY_API_KEY && env.CLOUDINARY_API_SECRET);

if (usingCloudinary) {
  cloudinary.config({
    cloud_name: env.CLOUDINARY_CLOUD_NAME,
    api_key: env.CLOUDINARY_API_KEY,
    api_secret: env.CLOUDINARY_API_SECRET,
    secure: true,
  });
}

/** Images are delivered resized/re-encoded; everything else (pdf, csv, ai…) is stored raw. */
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg']);
const isImage = (name) => IMAGE_EXT.has(path.extname(name).toLowerCase());

/**
 * Strips delivery transformations so the database always holds the canonical
 * asset URL — `absoluteUrl` re-applies optimisation when serving, so changing
 * the optimisation later updates every existing image.
 */
export const canonicalImageUrl = (url) =>
  (typeof url === 'string' ? url.replace(/(\/image\/upload\/)(?:[^/]+\/)*?(v\d+\/)/, '$1$2') : url);

/**
 * Stores one uploaded file and returns { url, path, name, size }.
 * `url` is what goes into the database and is served to the app and website.
 */
export async function storeFile(file, folder) {
  if (!file) throw new ApiError(400, 'No file received.');

  if (!usingCloudinary) {
    // Local disk fallback (development only — Render's disk is wiped on deploy).
    const dir = `uploads/${folder === 'products' || folder === 'categories' ? 'catalog' : 'designs'}`;
    await fs.mkdir(dir, { recursive: true });
    const filename = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}${path.extname(file.originalname).toLowerCase()}`;
    await fs.writeFile(path.join(dir, filename), file.buffer);
    const relative = `/${dir}/${filename}`;
    return { url: `${env.PUBLIC_BASE_URL}${relative}`, path: relative, name: file.originalname, size: file.size };
  }

  const uploaded = await new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: `spocart/${folder}`,
        resource_type: isImage(file.originalname) ? 'image' : 'raw',
        use_filename: false,             // random public_id — files are not guessable
        unique_filename: true,
        overwrite: false,
        // Keep the original but cap huge photos; delivery still re-optimises per request.
        ...(isImage(file.originalname) && { transformation: [{ width: 1600, height: 1600, crop: 'limit', quality: 'auto:good' }] }),
      },
      (err, result) => (err ? reject(new ApiError(502, `Upload failed: ${err.message}`)) : resolve(result)),
    );
    stream.end(file.buffer);
  });

  return { url: uploaded.secure_url, path: uploaded.public_id, name: file.originalname, size: uploaded.bytes };
}

/**
 * Removes one stored file, given whatever `storeFile` put in the database —
 * a Cloudinary public_id, or a local path in development.
 *
 * Used when a buyer closes their account: artwork they uploaded is theirs, and
 * leaving it on a CDN would mean the deletion only looked complete. Never
 * throws — a file that is already gone, or a storage hiccup, must not abort the
 * deletion of the records that actually matter.
 */
export async function deleteFile(stored) {
  if (!stored || typeof stored !== 'string') return;

  if (!usingCloudinary || stored.startsWith('/uploads/')) {
    await fs.unlink(path.join('.', stored.replace(/^\//, ''))).catch(() => null);
    return;
  }

  // The public_id does not say whether it went up as an image or a raw file,
  // and destroying with the wrong resource_type is a no-op, so try both.
  for (const resourceType of ['image', 'raw']) {
    try {
      const res = await cloudinary.uploader.destroy(stored, { resource_type: resourceType });
      if (res?.result === 'ok') return;
    } catch {
      // Try the other type, then give up quietly.
    }
  }
}

