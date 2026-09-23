// Customer uploads: jersey/kit artwork from the app and BOQ / tender documents
// from the website. Stored via the storage service (Cloudinary in production).
import { Router } from 'express';
import multer from 'multer';
import path from 'node:path';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler, ApiError } from '../middleware/error.js';
import { ok } from '../utils/respond.js';
import { storeFile } from '../services/storage.js';

const ALLOWED = new Set(['.png', '.jpg', '.jpeg', '.pdf', '.ai', '.svg', '.xlsx', '.xls', '.csv', '.doc', '.docx']);

const upload = multer({
  storage: multer.memoryStorage(),
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
  ok(res, await storeFile(req.file, 'quotes'), 201);
}));

export default r;
