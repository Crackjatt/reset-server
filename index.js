// index.js (fixed)
// Reset server for OTP / password reset with Supabase + Nodemailer
// Expects env:
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE  OR  SERVICE_ROLE_KEY
//   EMAIL_USER
//   EMAIL_PASS
//   PORT (optional)

import express from "express";
import nodemailer from "nodemailer";
import dotenv from "dotenv";

dotenv.config();

/**
 * Safe fetch loader:
 * - Use global fetch when available (Node 18+)
 * - Otherwise dynamically import node-fetch
 */
let safeFetch = globalThis.fetch;
async function getFetch() {
  if (safeFetch) return safeFetch;
  try {
    const mod = await import("node-fetch");
    safeFetch = mod.default;
    return safeFetch;
  } catch (e) {
    console.error("node-fetch not available and global fetch missing. Fetch calls will fail.", e);
    throw e;
  }
}

const app = express();
app.use(express.json({ limit: "100kb" }));

// Simple CORS for testing / mobile clients
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, apikey, x-requested-with"
  );
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// JSON parse error handler (must be after express.json)
app.use((err, req, res, next) => {
  if (err && err.type === "entity.parse.failed") {
    console.error("JSON parse error:", err.message);
    return res.status(400).json({ error: "Invalid JSON sent to server" });
  }
  next();
});

// helper to read env safely and trim
function safeEnv(name) {
  return process.env[name] ? process.env[name].trim() : undefined;
}

// Accept either SUPABASE_SERVICE_ROLE or SERVICE_ROLE_KEY
function getServiceRoleKey() {
  return safeEnv("SUPABASE_SERVICE_ROLE") || safeEnv("SERVICE_ROLE_KEY") || safeEnv("SUPABASE_KEY");
}

// ---------- HEALTH ----------
app.get("/", (req, res) => {
  const SUPABASE_URL = safeEnv("SUPABASE_URL");
  const key = getServiceRoleKey();
  const info = {
    status: "ok",
    supabase_configured: !!(SUPABASE_URL && key)
  };
  res.json(info);
});

// ---------- SEND CODE ----------
app.post("/send-code", async (req, res) => {
  try {
    const body = req.body || {};
    const email = (body.email || body.user_email || "").toString().trim();
    if (!email) return res.status(400).json({ error: "Email required" });

    const code = Math.floor(100000 + Math.random() * 900000).toString();

    const SUPABASE_URL = safeEnv("SUPABASE_URL");
    const SERVICE_ROLE_KEY = getServiceRoleKey();
    if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
      console.error("Missing SUPABASE_URL or SERVICE_ROLE_KEY");
      return res.status(500).json({ error: "Server misconfigured (missing supabase keys)" });
    }

    // Insert into password_resets table (Postgres REST).
    // Ensure your Supabase table name and CORS/policies allow this key to insert.
    const fetchImpl = await getFetch();
    const insertUrl = `${SUPABASE_URL.replace(/\/$/, "")}/rest/v1/password_resets`;
    const insertResp = await fetchImpl(insertUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
        Prefer: "return=representation"
      },
      body: JSON.stringify({ email, code })
    });

    const insertText = await insertResp.text();
    console.log("Supabase insert:", insertResp.status, insertText);
    if (!insertResp.ok) {
      return res.status(500).json({ error: "Failed to store reset code", detail: insertText });
    }

    // Send email using nodemailer (Gmail example). Configure EMAIL_USER and EMAIL_PASS
    const EMAIL_USER = safeEnv("EMAIL_USER");
    const EMAIL_PASS = safeEnv("EMAIL_PASS");
    if (!EMAIL_USER || !EMAIL_PASS) {
      console.error("Missing email credentials in env");
      return res.status(500).json({ error: "Server misconfigured (missing email creds)" });
    }

    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: { user: EMAIL_USER, pass: EMAIL_PASS }
    });

    try {
      await transporter.verify();
    } catch (verifyErr) {
      console.error("Nodemailer verify failed:", verifyErr && verifyErr.message);
      return res.status(500).json({ error: "Email provider authentication failed", detail: verifyErr.message });
    }

    try {
      const info = await transporter.sendMail({
        from: EMAIL_USER,
        to: email,
        subject: "Your password reset code",
        text: `Your reset code is: ${code}`
      });
      console.log("Mail sent:", info && info.messageId);
    } catch (mailErr) {
      console.error("Mail send failed:", mailErr && mailErr.message);
      return res.status(500).json({ error: "Failed to send email", detail: mailErr.message });
    }

    return res.json({ success: true, message: "Reset code stored and email sent" });
  } catch (err) {
    console.error("send-code error:", err);
    return res.status(500).json({ error: "Server error", detail: err && err.message });
  }
});

// ---------- VERIFY CODE ----------
app.post("/verify-code", async (req, res) => {
  try {
    const body = req.body || {};
    const email = (body.email || body.user_email || "").toString().trim();
    const code = (body.code || body.user_code || "").toString().trim();

    if (!email || !code) return res.status(400).json({ error: "Email and code required" });

    const SUPABASE_URL = safeEnv("SUPABASE_URL");
    const SERVICE_ROLE_KEY = getServiceRoleKey();
    if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
      return res.status(500).json({ error: "Server misconfigured (missing supabase keys)" });
    }

    const fetchImpl = await getFetch();
    const rpcUrl = `${SUPABASE_URL.replace(/\/$/, "")}/rest/v1/rpc/verify_reset_code`;
    const rpcResp = await fetchImpl(rpcUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SERVICE_ROLE_KEY}`
      },
      body: JSON.stringify({ user_email: email, user_code: code })
    });

    const rpcText = await rpcResp.text();
    console.log("verify RPC:", rpcResp.status, rpcText);

    if (!rpcResp.ok) {
      return res.status(500).json({ error: "RPC failed", detail: rpcText });
    }

    // RPC might return boolean true/false or text "true"
    let valid = false;
    try {
      const parsed = JSON.parse(rpcText);
      valid = parsed === true || parsed === "true";
    } catch {
      valid = rpcText === "true";
    }

    return res.json({ success: true, valid });
  } catch (err) {
    console.error("verify-code error:", err);
    return res.status(500).json({ error: "Server error", detail: err && err.message });
  }
});

// ---------- RESET PASSWORD ----------
app.post("/reset-password", async (req, res) => {
  try {
    const body = req.body || {};
    const email = (body.email || body.user_email || "").toString().trim();
    const newPassword = (body.new_password || body.password || "").toString();
    const code = (body.code || body.user_code || "").toString().trim();

    if (!email || !newPassword || !code)
      return res.status(400).json({ error: "email, new_password and code are required" });

    const SUPABASE_URL = safeEnv("SUPABASE_URL");
    const SERVICE_ROLE_KEY = getServiceRoleKey();
    if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
      return res.status(500).json({ error: "Server misconfigured (missing supabase keys)" });
    }

    const fetchImpl = await getFetch();
    // verify code via RPC
    const verifyUrl = `${SUPABASE_URL.replace(/\/$/, "")}/rest/v1/rpc/verify_reset_code`;
    const verifyResp = await fetchImpl(verifyUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SERVICE_ROLE_KEY}`
      },
      body: JSON.stringify({ user_email: email, user_code: code })
    });

    const verifyText = await verifyResp.text();
    console.log("verify RPC (reset-password):", verifyResp.status, verifyText);

    let verified = false;
    try {
      const parsed = JSON.parse(verifyText);
      verified = parsed === true || parsed === "true";
    } catch {
      verified = verifyText === "true";
    }

    if (!verifyResp.ok || !verified) {
      return res.status(400).json({ error: "Invalid or expired code", detail: verifyText });
    }

    // fetch user by email via Supabase Admin API
    const usersUrl = `${SUPABASE_URL.replace(/\/$/, "")}/auth/v1/admin/users?email=eq.${encodeURIComponent(email)}`;
    const usersResp = await fetchImpl(usersUrl, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        apikey: SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SERVICE_ROLE_KEY}`
      }
    });

    const usersText = await usersResp.text();
    console.log("admin users:", usersResp.status, usersText);
    if (!usersResp.ok) {
      return res.status(500).json({ error: "Failed to fetch user", detail: usersText });
    }

    let parsedUsers;
    try {
      parsedUsers = JSON.parse(usersText);
    } catch (e) {
      console.error("Failed parsing users response:", e, usersText);
      return res.status(500).json({ error: "Failed to parse user response", detail: usersText });
    }

    const usersArray = Array.isArray(parsedUsers) ? parsedUsers : (parsedUsers.data || parsedUsers.users || []);
    if (!usersArray || usersArray.length === 0) {
      return res.status(404).json({ error: "User not found in Supabase Auth", detail: parsedUsers });
    }
    const user = usersArray[0];

    // update password
    const updateUrl = `${SUPABASE_URL.replace(/\/$/, "")}/auth/v1/admin/users/${user.id}`;
    const updateResp = await fetchImpl(updateUrl, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        apikey: SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SERVICE_ROLE_KEY}`
      },
      body: JSON.stringify({ password: newPassword })
    });

    const updateText = await updateResp.text();
    console.log("update user password:", updateResp.status, updateText);

    if (!updateResp.ok) {
      return res.status(500).json({ error: "Failed to update password", status: updateResp.status, detail: updateText });
    }

    return res.json({ success: true, message: "Password updated" });
  } catch (err) {
    console.error("reset-password error:", err);
    return res.status(500).json({ error: "Server error", detail: err && err.message });
  }
});

// final catch-all 404
app.use((req, res) => {
  res.status(404).json({ error: "Not found" });
});

const PORT = Number(process.env.PORT || process.env.RAILWAY_PORT || 8080);
app.listen(PORT, () => {
  console.log(`Reset server listening on port ${PORT}`);
});
