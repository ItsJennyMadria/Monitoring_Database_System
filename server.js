require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 5000;

//  middleware 
app.use(cors());
app.use(express.json());

// to connect to database
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

//Health check route
app.get('/', (req, res) => {
  res.send('Server is running');
});

// Start the server
app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});

//FOR SCANNING QR CODE AND RECORDING ATTENDANCE
app.post('/api/attendance/scan', async (req, res) => {
    const {student_id, event_id } = req.body;

    try {
        //for checking duplicated scanning of QR code for specific event 
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

    //INSERT NEW ATTENDANCE RECORD
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