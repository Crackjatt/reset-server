import express from "express";
import nodemailer from "nodemailer";
import dotenv from "dotenv";

dotenv.config();

const app = express();
// Bada data handle karne ke liye limit badhai
app.use(express.json({ limit: "100kb" }));

// CORS Headers (Manual setup)
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, apikey");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// JSON Parse Error Handler
app.use((err, req, res, next) => {
  if (err && err.type === "entity.parse.failed") {
    console.error("JSON parse error:", err.message);
    return res.status(400).json({ error: "Invalid JSON sent to server" });
  }
  next();
});

function safeEnv(name) {
  return process.env[name] ? process.env[name].trim() : undefined;
}

// --- ROUTES ---

// 1. Send Code
app.post("/send-code", async (req, res) => {
  try {
    const email = (req.body && (req.body.email || req.body.user_email))?.toString();
    if (!email) return res.status(400).json({ error: "Email required" });

    const code = Math.floor(100000 + Math.random() * 900000).toString();

    const SUPABASE_URL = safeEnv("SUPABASE_URL");
    const SERVICE_ROLE_KEY = safeEnv("SERVICE_ROLE_KEY");

    if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
      console.error("Missing SUPABASE_URL or SERVICE_ROLE_KEY");
      return res.status(500).json({ error: "Server misconfigured (missing supabase keys)" });
    }

    // Supabase mein code save karo
    const supaResp = await fetch(`${SUPABASE_URL.replace(/\/$/, "")}/rest/v1/password_resets`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": SERVICE_ROLE_KEY,
        "Authorization": `Bearer ${SERVICE_ROLE_KEY}`,
        "Prefer": "return=representation"
      },
      body: JSON.stringify({ email, code })
    });

    const supaText = await supaResp.text();
    console.log("SUPA insert status:", supaResp.status);
    
    if (!supaResp.ok) {
      return res.status(500).json({ error: "Failed to store reset code", detail: supaText });
    }

    // Email bhejo
    if (!safeEnv("EMAIL_USER") || !safeEnv("EMAIL_PASS")) {
      console.error("Missing email credentials");
      return res.status(500).json({ error: "Server misconfigured (missing email creds)" });
    }

    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: { user: safeEnv("EMAIL_USER"), pass: safeEnv("EMAIL_PASS") },
    });

    try {
      await transporter.verify();
    } catch (verifyErr) {
      console.error("Nodemailer verify failed:", verifyErr.message);
      return res.status(500).json({ error: "Email provider auth failed", detail: verifyErr.message });
    }

    try {
      await transporter.sendMail({
        from: safeEnv("EMAIL_USER"),
        to: email,
        subject: "Your Reset Code",
        text: `Your reset code is: ${code}`
      });
      console.log("Mail sent to:", email);
    } catch (mailErr) {
      console.error("Mail error:", mailErr.message);
      return res.status(500).json({ error: "Failed to send email", detail: mailErr.message });
    }

    return res.json({ success: true, message: "Reset code sent!" });
  } catch (err) {
    console.error("Error (send-code):", err);
    return res.status(500).json({ error: "Server error", detail: err.message });
  }
});

// 2. Verify Code
app.post("/verify-code", async (req, res) => {
  try {
    const email = (req.body && (req.body.email || req.body.user_email))?.toString();
    const code = (req.body && (req.body.code || req.body.user_code))?.toString();

    if (!email || !code) return res.status(400).json({ error: "Email and code required" });

    const SUPABASE_URL = safeEnv("SUPABASE_URL");
    const SERVICE_ROLE_KEY = safeEnv("SERVICE_ROLE_KEY");

    const resp = await fetch(
      `${SUPABASE_URL.replace(/\/$/, "")}/rest/v1/rpc/verify_reset_code`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "apikey": SERVICE_ROLE_KEY,
          "Authorization": `Bearer ${SERVICE_ROLE_KEY}`
        },
        body: JSON.stringify({ user_email: email, user_code: code })
      }
    );

    const text = await resp.text();
    let result;
    try { result = JSON.parse(text); } catch { result = text; }

    if (!resp.ok) {
      console.error("Verify RPC failed:", text);
      return res.status(500).json({ error: "RPC failed", detail: text });
    }

    const valid = (result === true) || (result === "true") || (result === JSON.stringify(true));
    return res.json({ success: true, valid });
  } catch (err) {
    console.error("Error (verify-code):", err);
    return res.status(500).json({ error: "Server error", detail: err.message });
  }
});

// 3. Reset Password
app.post("/reset-password", async (req, res) => {
  try {
    const email = (req.body && (req.body.email || req.body.user_email))?.toString();
    const new_password = (req.body && (req.body.new_password || req.body.password))?.toString();
    const code = (req.body && (req.body.code || req.body.user_code))?.toString();

    if (!email || !new_password || !code)
      return res.status(400).json({ error: "email, new_password and code required" });

    const SUPABASE_URL = safeEnv("SUPABASE_URL");
    const SERVICE_ROLE_KEY = safeEnv("SERVICE_ROLE_KEY");

    // Code verify karo
    const verifyResp = await fetch(`${SUPABASE_URL.replace(/\/$/, "")}/rest/v1/rpc/verify_reset_code`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": SERVICE_ROLE_KEY,
        "Authorization": `Bearer ${SERVICE_ROLE_KEY}`
      },
      body: JSON.stringify({ user_email: email, user_code: code })
    });

    const verifyText = await verifyResp.text();
    let verified = false;
    try {
      const parsed = JSON.parse(verifyText);
      if (parsed === true || parsed === "true") verified = true;
    } catch { if (verifyText === "true") verified = true; }

    if (!verifyResp.ok || !verified) {
      return res.status(400).json({ error: "Invalid or expired code" });
    }

    // User ID dhundo
    const userResp = await fetch(`${SUPABASE_URL.replace(/\/$/, "")}/auth/v1/admin/users?email=eq.${encodeURIComponent(email)}`, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        "apikey": SERVICE_ROLE_KEY,
        "Authorization": `Bearer ${SERVICE_ROLE_KEY}`
      }
    });

    const userText = await userResp.text();
    const parsedUsers = JSON.parse(userText);
    const usersArray = Array.isArray(parsedUsers) ? parsedUsers : (parsedUsers.users || []);

    if (!usersArray.length) {
      return res.status(404).json({ error: "User not found" });
    }
    const user = usersArray[0];

    // Password Update karo
    const updateResp = await fetch(`${SUPABASE_URL.replace(/\/$/, "")}/auth/v1/admin/users/${user.id}`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "apikey": SERVICE_ROLE_KEY,
        "Authorization": `Bearer ${SERVICE_ROLE_KEY}`
      },
      body: JSON.stringify({ password: new_password })
    });

    if (!updateResp.ok) {
      return res.status(500).json({ error: "Failed to update password" });
    }

    return res.json({ success: true, message: "Password updated!" });
  } catch (err) {
    console.error("Error (reset-password):", err);
    return res.status(500).json({ error: "Server error", detail: err.message });
  }
});

// Health check
app.get("/", (req, res) => res.json({ status: "ok" }));

// --- IMPORTANT: LISTEN ON 0.0.0.0 ---
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
app.listen(PORT, "0.0.0.0", () => {
    console.log(`Reset server running on port ${PORT}`);
});
