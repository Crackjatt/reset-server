// reset-server/index.js
import express from "express";
import nodemailer from "nodemailer";
import dotenv from "dotenv";
import fetch from "node-fetch";

dotenv.config();

const app = express();
// increase size a bit and ensure JSON parse errors are handled
app.use(express.json({ limit: "100kb" }));

// simple CORS so phone can call if needed
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, apikey");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// JSON parse error handler (prevents server crash)
app.use((err, req, res, next) => {
  if (err && err.type === "entity.parse.failed") {
    console.error("JSON parse error:", err.message);
    return res.status(400).json({ error: "Invalid JSON sent to server" });
  }
  next();
});

// ---------- HELPERS ----------
function safeEnv(name) {
  return process.env[name] ? process.env[name].trim() : undefined;
}

// ---------- SEND CODE ----------
app.post("/send-code", async (req, res) => {
  try {
    // accept either req.body.email or req.body.user_email (some clients used this)
    const email = (req.body && (req.body.email || req.body.user_email))?.toString();
    if (!email) return res.status(400).json({ error: "Email required" });

    const code = Math.floor(100000 + Math.random() * 900000).toString();

    const SUPABASE_URL = safeEnv("SUPABASE_URL");
    const SERVICE_ROLE_KEY = safeEnv("SERVICE_ROLE_KEY");
    if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
      console.error("Missing SUPABASE_URL or SERVICE_ROLE_KEY");
      return res.status(500).json({ error: "Server misconfigured (missing supabase keys)" });
    }

    // store reset code
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
    console.log("SUPA insert status:", supaResp.status, "body:", supaText);

    if (!supaResp.ok) {
      return res.status(500).json({ error: "Failed to store reset code", detail: supaText });
    }

    // send email
    if (!safeEnv("EMAIL_USER") || !safeEnv("EMAIL_PASS")) {
      console.error("Missing email credentials in .env");
      return res.status(500).json({ error: "Server misconfigured (missing email creds)" });
    }

    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: { user: safeEnv("EMAIL_USER"), pass: safeEnv("EMAIL_PASS") },
    });

    try {
      await transporter.verify();
      console.log("Nodemailer connected OK (verified).");
    } catch (verifyErr) {
      console.error("Nodemailer verify failed:", verifyErr && verifyErr.message);
      return res.status(500).json({ error: "Email provider authentication failed", detail: verifyErr.message });
    }

    try {
      const mailInfo = await transporter.sendMail({
        from: safeEnv("EMAIL_USER"),
        to: email,
        subject: "Your Reset Code",
        text: `Your reset code is: ${code}`
      });
      console.log("Mail sent ok:", mailInfo && mailInfo.messageId);
    } catch (mailErr) {
      console.error("Mail error:", mailErr && mailErr.message);
      return res.status(500).json({ error: "Failed to send email", detail: mailErr.message });
    }

    return res.json({ success: true, message: "Reset code sent!" });
  } catch (err) {
    console.error("Unhandled server error (send-code):", err);
    return res.status(500).json({ error: "Server error", detail: err.message });
  }
});

// ---------- VERIFY CODE ----------
app.post("/verify-code", async (req, res) => {
  try {
    // accept both names used by clients
    const email = (req.body && (req.body.email || req.body.user_email))?.toString();
    const code = (req.body && (req.body.code || req.body.user_code))?.toString();

    if (!email || !code) return res.status(400).json({ error: "Email and code required" });

    const SUPABASE_URL = safeEnv("SUPABASE_URL");
    const SERVICE_ROLE_KEY = safeEnv("SERVICE_ROLE_KEY");
    if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
      return res.status(500).json({ error: "Server misconfigured (missing supabase keys)" });
    }

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
      console.error("verify_reset_code RPC failed:", text);
      return res.status(500).json({ error: "RPC failed", detail: text });
    }

    const valid = (result === true) || (result === "true") || (result === JSON.stringify(true));
    return res.json({ success: true, valid });
  } catch (err) {
    console.error("Unhandled server error (verify-code):", err);
    return res.status(500).json({ error: "Server error", detail: err.message });
  }
});

// ---------- RESET PASSWORD ----------
app.post("/reset-password", async (req, res) => {
  try {
    const email = (req.body && (req.body.email || req.body.user_email))?.toString();
    const new_password = (req.body && (req.body.new_password || req.body.password))?.toString();
    const code = (req.body && (req.body.code || req.body.user_code))?.toString();

    if (!email || !new_password || !code)
      return res.status(400).json({ error: "email, new_password and code are required" });

    const SUPABASE_URL = safeEnv("SUPABASE_URL");
    const SERVICE_ROLE_KEY = safeEnv("SERVICE_ROLE_KEY");
    if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
      return res.status(500).json({ error: "Server misconfigured (missing supabase keys)" });
    }

    // verify rpc
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
    } catch {
      if (verifyText === "true") verified = true;
    }

    if (!verifyResp.ok || !verified) {
      console.error("Code verification failed:", verifyResp.status, verifyText);
      return res.status(400).json({ error: "Invalid or expired code", detail: verifyText });
    }

    // fetch user id
    const userResp = await fetch(`${SUPABASE_URL.replace(/\/$/, "")}/auth/v1/admin/users?email=eq.${encodeURIComponent(email)}`, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        "apikey": SERVICE_ROLE_KEY,
        "Authorization": `Bearer ${SERVICE_ROLE_KEY}`
      }
    });

    const userText = await userResp.text();
    let parsedUsers;
    try { parsedUsers = JSON.parse(userText); } catch (e) {
      console.error("Failed to parse admin users response:", userText);
      return res.status(500).json({ error: "Failed to parse Supabase user response", detail: userText });
    }

    let usersArray = Array.isArray(parsedUsers) ? parsedUsers : (parsedUsers.users || parsedUsers.data || null);
    if (!usersArray || usersArray.length === 0) {
      console.error("User not found in admin/users response:", parsedUsers);
      return res.status(404).json({ error: "User not found in Supabase Auth", emailSearched: email, raw: parsedUsers });
    }
    const user = usersArray[0];

    // update password
    const updateResp = await fetch(`${SUPABASE_URL.replace(/\/$/, "")}/auth/v1/admin/users/${user.id}`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "apikey": SERVICE_ROLE_KEY,
        "Authorization": `Bearer ${SERVICE_ROLE_KEY}`
      },
      body: JSON.stringify({ password: new_password })
    });

    const updateText = await updateResp.text();
    if (!updateResp.ok) {
      console.error("Password update failed. status:", updateResp.status, "body:", updateText);
      return res.status(500).json({ error: "Failed to update password", status: updateResp.status, detail: updateText });
    }

    return res.json({ success: true, message: "Password updated!" });
  } catch (err) {
    console.error("reset-password error:", err);
    return res.status(500).json({ error: "Server error", detail: err.message });
  }
});

// health
app.get("/", (req, res) => res.send("Reset server: OK"));

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
app.listen(PORT, () => console.log(`Reset server running on port ${PORT}`));
