// routes/rooms.js
import express from "express";
import pkg from "pg";
const { Pool } = pkg;

const router = express.Router();

// Pool uses SUPABASE_DB_URL from env (set on Railway)
const pool = new Pool({
  connectionString: process.env.SUPABASE_DB_URL,
  ssl: { rejectUnauthorized: false }
});

// GET /rooms -> list rooms with real online member counts
router.get("/", async (req, res) => {
  try {
    const q = `
      SELECT room_id, COUNT(*)::int AS member_count
      FROM room_members
      WHERE is_online = true
      GROUP BY room_id
      ORDER BY member_count DESC;
    `;
    const result = await pool.query(q);
    return res.json({ success: true, rooms: result.rows });
  } catch (err) {
    console.error("ROOM LIST ERROR:", err?.message || err);
    return res.status(500).json({ success: false, error: err?.message || "server error" });
  }
});

// POST /rooms/join -> mark user online (upsert)
router.post("/join", async (req, res) => {
  const { room_id, user_id } = req.body;
  if (!room_id || !user_id) return res.status(400).json({ success: false, message: "Missing room_id or user_id" });

  try {
    await pool.query(`SELECT upsert_room_member($1, $2, true);`, [room_id, user_id]);
    return res.json({ success: true });
  } catch (err) {
    console.error("ROOM JOIN ERROR:", err?.message || err);
    return res.status(500).json({ success: false, error: err?.message || "server error" });
  }
});

// POST /rooms/leave -> mark user offline (upsert)
router.post("/leave", async (req, res) => {
  const { room_id, user_id } = req.body;
  if (!room_id || !user_id) return res.status(400).json({ success: false, message: "Missing room_id or user_id" });

  try {
    await pool.query(`SELECT upsert_room_member($1, $2, false);`, [room_id, user_id]);
    return res.json({ success: true });
  } catch (err) {
    console.error("ROOM LEAVE ERROR:", err?.message || err);
    return res.status(500).json({ success: false, error: err?.message || "server error" });
  }
});

export default router;
