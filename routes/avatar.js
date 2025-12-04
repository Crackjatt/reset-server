// routes/avatar.js
import express from "express";
import { v2 as cloudinary } from "cloudinary";

const router = express.Router();

function safeEnv(name) {
  return process.env[name] ? process.env[name].trim() : undefined;
}

// configure cloudinary using env (same as other route)
cloudinary.config({
  cloud_name: safeEnv("CLOUDINARY_CLOUD_NAME"),
  api_key: safeEnv("CLOUDINARY_API_KEY"),
  api_secret: safeEnv("CLOUDINARY_API_SECRET"),
});

/**
 * POST /avatar/update
 * Body: { user_id: "<id>", new_public_id: "avatars/xxx", new_url: "https://..." }
 * Header: apikey: <SERVICE_ROLE_KEY>   (server-side auth)
 *
 * Flow:
 *  - Fetch current profile from Supabase (service role key)
 *  - If old public_id exists and different -> cloudinary.uploader.destroy(oldPublicId)
 *  - Update Supabase profiles row with new avatar_url & avatar_public_id
 *  - Return updated profile (representation)
 */
router.post("/update", async (req, res) => {
  try {
    const SERVICE_ROLE_KEY = safeEnv("SERVICE_ROLE_KEY");
    const SUPABASE_URL = safeEnv("SUPABASE_URL");

    // Basic header-based protection
    const headerKey = (req.get("apikey") || req.get("x-apikey") || req.get("authorization")) || "";
    if (!SERVICE_ROLE_KEY) return res.status(500).json({ error: "Server misconfigured (missing SERVICE_ROLE_KEY)" });

    // If authorization header contains Bearer <key>, support that too
    const providedKey = headerKey.startsWith("Bearer ") ? headerKey.replace("Bearer ", "").trim() : headerKey;

    if (!providedKey || providedKey !== SERVICE_ROLE_KEY) {
      return res.status(403).json({ error: "Unauthorized. Provide service apikey header." });
    }

    const body = req.body || {};
    const userId = (body.user_id || body.userId || body.id)?.toString();
    const newPublicId = body.new_public_id || body.newPublicId || body.public_id || body.avatar_public_id;
    const newUrl = body.new_url || body.newUrl || body.avatar_url;

    if (!userId || !newPublicId || !newUrl) {
      return res.status(400).json({ error: "Missing fields. Required: user_id, new_public_id, new_url" });
    }

    // 1) Fetch existing profile
    const profileResp = await fetch(`${SUPABASE_URL.replace(/\/$/, "")}/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}`, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        "apikey": SERVICE_ROLE_KEY,
        "Authorization": `Bearer ${SERVICE_ROLE_KEY}`
      }
    });

    if (!profileResp.ok) {
      const t = await profileResp.text();
      return res.status(500).json({ error: "Failed to fetch profile", detail: t });
    }

    const profileText = await profileResp.text();
    let parsedProfile;
    try { parsedProfile = JSON.parse(profileText); } catch { parsedProfile = []; }

    const existing = Array.isArray(parsedProfile) && parsedProfile.length ? parsedProfile[0] : null;

    const oldPublicId = existing?.avatar_public_id || null;

    // 2) If oldPublicId exists and different from new -> delete it from Cloudinary
    if (oldPublicId && oldPublicId !== newPublicId) {
      try {
        // Use cloudinary uploader destroy directly
        await cloudinary.uploader.destroy(oldPublicId, { invalidate: true, resource_type: "image" });
        // Note: cloudinary returns object; we ignore full result and proceed
      } catch (err) {
        console.error("Error deleting old avatar from Cloudinary:", err);
        // proceed — do not fail entire request just because delete failed; but return warning
      }
    }

    // 3) Update Supabase profile row with new avatar_url and avatar_public_id
    const updateResp = await fetch(`${SUPABASE_URL.replace(/\/$/, "")}/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "apikey": SERVICE_ROLE_KEY,
        "Authorization": `Bearer ${SERVICE_ROLE_KEY}`,
        "Prefer": "return=representation"
      },
      body: JSON.stringify({
        avatar_url: newUrl,
        avatar_public_id: newPublicId
      })
    });

    const updateText = await updateResp.text();
    if (!updateResp.ok) {
      return res.status(500).json({ error: "Failed to update profile", detail: updateText });
    }

    let updated;
    try { updated = JSON.parse(updateText); } catch { updated = updateText; }

    return res.json({ success: true, updated });
  } catch (err) {
    console.error("Error in /avatar/update:", err);
    return res.status(500).json({ error: err.message || "avatar update failed" });
  }
});

export default router;
