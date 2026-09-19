import { Router } from 'express';
import multer from 'multer';
import path from 'node:path';
import crypto from 'node:crypto';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler, ApiError } from '../middleware/error.js';
import { ok } from '../utils/respond.js';
import { absoluteUrl } from '../services/orders.js';

// Designs (logo artwork) and BOQ / tender documents from the website.
const ALLOWED = new Set(['.png', '.jpg', '.jpeg', '.pdf', '.ai', '.svg', '.xlsx', '.xls', '.csv', '.doc', '.docx']);

// Local disk for now (served at /uploads). Swap `storage` for S3/R2 in production.
const storage = multer.diskStorage({
  destination: 'uploads/designs',
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED.has(ext)) return cb(new ApiError(400, 'Upload PNG, JPG, PDF, AI, SVG, Excel, CSV or Word files only.'));
    cb(null, true);
  },
});

const r = Router();

r.post('/design', requireAuth, upload.single('file'), asyncHandler(async (req, res) => {
  if (!req.file) throw new ApiError(400, 'Attach a file in the "file" field.');
  const relative = `/uploads/designs/${req.file.filename}`;
  ok(res, { url: absoluteUrl(relative), path: relative, name: req.file.originalname, size: req.file.size }, 201);
}));

export default r;
