import express from "express";
import dotenv from "dotenv";

dotenv.config();

import roomsRouter from "./routes/rooms.js"; // <-- ADDED: rooms routes

// NEW: cloudinary delete route import
import cloudinaryDeleteRoute from "./cloudinary-delete-route.js";

const app = express();
// keep same limit as before (100kb) — this server doesn't accept big uploads directly
app.use(express.json({ limit: "100kb" }));

// CORS Headers
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, apikey");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

function safeEnv(name) {
  return process.env[name] ? process.env[name].trim() : undefined;
}

// mount rooms router (ADDED)
app.use("/rooms", roomsRouter);

// MOUNT CLOUDINARY DELETE ROUTE (ADDED)
// This ensures POST /delete-image is handled by the route we added.
app.use("/delete-image", cloudinaryDeleteRoute);

// 1. Send Code Route
app.post("/send-code", async (req, res) => {
  try {
    const email = (req.body && (req.body.email || req.body.user_email))?.toString();
    if (!email) return res.status(400).json({ error: "Email required" });

    const code = Math.floor(100000 + Math.random() * 900000).toString();

    const SUPABASE_URL = safeEnv("SUPABASE_URL");
    const SERVICE_ROLE_KEY = safeEnv("SERVICE_ROLE_KEY");
    // API Key uthao
    const BREVO_API_KEY = safeEnv("EMAIL_PASS"); 

    if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
      return res.status(500).json({ error: "Server misconfigured (missing supabase keys)" });
    }

    // Save to Supabase
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

    if (!supaResp.ok) {
        const errText = await supaResp.text();
        return res.status(500).json({ error: "Failed to store reset code", detail: errText });
    }

    if (!BREVO_API_KEY) {
      console.error("Missing Brevo API Key");
      return res.status(500).json({ error: "Server misconfigured (missing email key)" });
    }

    // --- YEH HAI ASLI CHANGE: HTTP API ---
    // Logs mein yeh line aani chahiye:
    console.log("Sending email via Brevo HTTP API to:", email);

    const emailResponse = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: {
        "accept": "application/json",
        "api-key": BREVO_API_KEY, // Tumhari xkeysib- wali key
        "content-type": "application/json"
      },
      body: JSON.stringify({
        sender: { name: "ZevooChat Security", email: safeEnv("EMAIL_USER") },
        to: [{ email: email }],
        subject: "Your Password Reset Code",
        htmlContent: `<p>Your reset code is: <strong>${code}</strong></p>`
      })
    });

    // Brevo ka response check karo
    const emailText = await emailResponse.text();
    let emailResult;
    try { emailResult = JSON.parse(emailText); } catch { emailResult = emailText; }

    if (!emailResponse.ok) {
      console.error("Brevo API Error:", emailResult);
      return res.status(500).json({ error: "Failed to send email via API", detail: emailResult });
    }

    console.log("Mail sent successfully. Message ID:", emailResult.messageId);
    return res.json({ success: true, message: "Reset code sent!" });

  } catch (err) {
    console.error("Error (send-code):", err);
    return res.status(500).json({ error: "Server error", detail: err.message });
  }
});

// 2. Verify Code Route
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
    if (!resp.ok) return res.status(500).json({ error: "RPC failed", detail: text });

    let result; try { result = JSON.parse(text); } catch { result = text; }
    const valid = (result === true) || (result === "true") || (result === JSON.stringify(true));
    return res.json({ success: true, valid });
  } catch (err) {
    return res.status(500).json({ error: "Server error", detail: err.message });
  }
});

// 3. Reset Password Route
app.post("/reset-password", async (req, res) => {
  try {
    const email = (req.body && (req.body.email || req.body.user_email))?.toString();
    const new_password = (req.body && (req.body.new_password || req.body.password))?.toString();
    const code = (req.body && (req.body.code || req.body.user_code))?.toString();

    if (!email || !new_password || !code) return res.status(400).json({ error: "All fields required" });

    const SUPABASE_URL = safeEnv("SUPABASE_URL");
    const SERVICE_ROLE_KEY = safeEnv("SERVICE_ROLE_KEY");

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

    if (!verifyResp.ok || !verified) return res.status(400).json({ error: "Invalid or expired code" });

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

    if (!usersArray.length) return res.status(404).json({ error: "User not found" });
    const user = usersArray[0];

    const updateResp = await fetch(`${SUPABASE_URL.replace(/\/$/, "")}/auth/v1/admin/users/${user.id}`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "apikey": SERVICE_ROLE_KEY,
        "Authorization": `Bearer ${SERVICE_ROLE_KEY}`
      },
      body: JSON.stringify({ password: new_password })
    });

    if (!updateResp.ok) return res.status(500).json({ error: "Failed to update password" });

    return res.json({ success: true, message: "Password updated!" });
  } catch (err) {
    return res.status(500).json({ error: "Server error", detail: err.message });
  }
});

app.get("/", (req, res) => res.json({ status: "ok" }));

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
app.listen(PORT, "0.0.0.0", () => {
    console.log(`Reset server running on port ${PORT}`);
});
