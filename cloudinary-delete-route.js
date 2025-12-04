// cloudinary-delete-route.js
// ESM module — ready to plug into your existing Express reset-server.

import express from "express";
import { v2 as cloudinary } from "cloudinary";

const router = express.Router();

/**
 * Minimal token check:
 * - Either send header "x-delete-token: <token>" OR body { token: "<token>" }.
 * - The server uses env var DELETE_TOKEN to validate.
 *
 * Body expected: { public_id: "avatars/xxxxx" } or in query ?public_id=...
 */

const DELETE_TOKEN = process.env.DELETE_TOKEN || "";

if (!process.env.CLOUDINARY_CLOUD_NAME || !process.env.CLOUDINARY_API_KEY || !process.env.CLOUDINARY_API_SECRET) {
  console.warn("Warning: Cloudinary env vars not found. Delete route will fail until you set CLOUDINARY_CLOUD_NAME / CLOUDINARY_API_KEY / CLOUDINARY_API_SECRET");
}

// configure cloudinary using env (works even if you already configured elsewhere)
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// POST /delete-image
router.post("/", async (req, res) => {
  try {
    const body = req.body || {};
    const headerToken = req.get("x-delete-token");
    const token = headerToken || body.token || "";

    if (!DELETE_TOKEN) {
      return res.status(500).json({ error: "Server not configured with DELETE_TOKEN" });
    }
    if (!token || token !== DELETE_TOKEN) {
      return res.status(403).json({ error: "Invalid or missing delete token" });
    }

    const publicId = body.public_id || req.query.public_id;
    if (!publicId) {
      return res.status(400).json({ error: "public_id required in body or query" });
    }

    // call cloudinary destroy
    const result = await cloudinary.uploader.destroy(publicId, { invalidate: true, resource_type: "image" });
    // result may be like { result: 'ok' } or { result: 'not_found' }, etc.
    return res.json({ success: true, result });
  } catch (err) {
    console.error("Error in /delete-image:", err);
    return res.status(500).json({ error: err.message || "delete failed" });
  }
});

export default router;
