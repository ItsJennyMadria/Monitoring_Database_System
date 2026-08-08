require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware 
app.use(cors());
app.use(express.json());

// Database connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

// Health check route
app.get('/', (req, res) => {
  res.send('Server is running');
});

// FOR SCANNING QR CODE AND RECORDING ATTENDANCE
app.post('/api/attendance/scan', async (req, res) => {
  const { student_id, event_id } = req.body;

  try {
    const checkAttendance = await pool.query(
      'SELECT * FROM attendance WHERE student_id = $1 AND event_id = $2',
      [student_id, event_id]
    );

    if (checkAttendance.rows.length > 0) {
      return res.status(400).json({
        success: false,
        message: 'Attendance already recorded for this student and event'
      });
    }

    const result = await pool.query(
      'INSERT INTO attendance (student_id, event_id, status) VALUES ($1, $2, $3) RETURNING *',
      [student_id, event_id, 'PRESENT']
    );

    res.status(200).json({
      success: true,
      message: 'Attendance recorded successfully!',
      data: result.rows[0]
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Database error' });
  }
});

// GET CLEARANCE STATUS FOR A STUDENT
app.get('/api/clearance/:student_id', async (req, res) => {
  const { student_id } = req.params;

  try {
    // 1. Get total mandatory events count
    const totalEventsQuery = await pool.query(
      'SELECT COUNT(*) FROM events WHERE is_mandatory = true'
    );
    const totalMandatoryEvents = parseInt(totalEventsQuery.rows[0].count);

    // 2. Get attended mandatory events count for this student
    const attendedQuery = await pool.query(
      `SELECT COUNT(DISTINCT a.event_id) 
       FROM attendance a 
       JOIN events e ON a.event_id = e.event_id 
       WHERE a.student_id = $1 AND e.is_mandatory = true`,
      [student_id]
    );
    const attendedEvents = parseInt(attendedQuery.rows[0].count);

    // 3. Determine status
    const isCleared = attendedEvents >= totalMandatoryEvents;

    res.json({
      success: true,
      data: {
        student_id,
        total_mandatory_events: totalMandatoryEvents,
        attended_events: attendedEvents,
        status: isCleared ? 'CLEARED' : 'PENDING'
      }
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Database error' });
  }
});

// START THE SERVER (ALWAYS AT THE VERY BOTTOM)
app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});