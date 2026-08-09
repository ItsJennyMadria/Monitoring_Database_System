require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const { Parser } = require('json2csv');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
const PORT = process.env.PORT || 5000;
const JWT_SECRET = process.env.JWT_SECRET || 'fallback_secret_key_change_in_prod';

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

// ==========================================
// AUTHENTICATION MIDDLEWARES
// ==========================================

// Verify JWT Token
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // Expecting "Bearer <TOKEN>"

  if (!token) {
    return res.status(401).json({ success: false, message: 'Access denied. No token provided.' });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ success: false, message: 'Invalid or expired token.' });
    }
    req.user = user; // Contains { user_id, username, email, role, student_id }
    next();
  });
};

// Role-based authorization middleware
const requireRole = (...allowedRoles) => {
  return (req, res, next) => {
    if (!req.user || !allowedRoles.includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: `Forbidden. Action requires one of these roles: ${allowedRoles.join(', ')}`
      });
    }
    next();
  };
};

// ==========================================
// AUTH ROUTES
// ==========================================

// REGISTER USER (ADMIN or STUDENT)
app.post('/api/auth/register', async (req, res) => {
  const { username, email, password, role, student_id } = req.body;

  if (!username || !email || !password) {
    return res.status(400).json({ success: false, message: 'Username, email, and password are required.' });
  }

  const userRole = role ? role.toUpperCase() : 'STUDENT';
  if (!['ADMIN', 'STUDENT'].includes(userRole)) {
    return res.status(400).json({ success: false, message: 'Role must be ADMIN or STUDENT.' });
  }

  try {
    // Hash password
    const saltRounds = 10;
    const password_hash = await bcrypt.hash(password, saltRounds);

    const result = await pool.query(
      `INSERT INTO users (username, email, password_hash, role, student_id)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING user_id, username, email, role, student_id, created_at`,
      [username, email, password_hash, userRole, student_id || null]
    );

    res.status(201).json({
      success: true,
      message: 'User registered successfully!',
      user: result.rows[0]
    });

  } catch (err) {
    console.error(err);
    if (err.code === '23505') { // Unique constraint violation
      return res.status(400).json({ success: false, message: 'Username, email, or student ID already exists.' });
    }
    res.status(500).json({ success: false, error: 'Database error during registration.' });
  }
});

// LOGIN USER
app.post('/api/auth/login', async (req, res) => {
  const { username_or_email, password } = req.body;

  if (!username_or_email || !password) {
    return res.status(400).json({ success: false, message: 'Username/email and password are required.' });
  }

  try {
    // Find user by username or email
    const userResult = await pool.query(
      `SELECT * FROM users WHERE username = $1 OR email = $1`,
      [username_or_email]
    );

    if (userResult.rows.length === 0) {
      return res.status(401).json({ success: false, message: 'Invalid credentials.' });
    }

    const user = userResult.rows[0];

    // Verify password
    const isPasswordValid = await bcrypt.compare(password, user.password_hash);
    if (!isPasswordValid) {
      return res.status(401).json({ success: false, message: 'Invalid credentials.' });
    }

    // Generate JWT Token
    const payload = {
      user_id: user.user_id,
      username: user.username,
      email: user.email,
      role: user.role,
      student_id: user.student_id
    };

    const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '8h' });

    res.json({
      success: true,
      message: 'Login successful!',
      token,
      user: {
        user_id: user.user_id,
        username: user.username,
        email: user.email,
        role: user.role,
        student_id: user.student_id
      }
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Database error during login.' });
  }
});

// GET CURRENT LOGGED-IN USER PROFILE
app.get('/api/auth/me', authenticateToken, async (req, res) => {
  res.json({
    success: true,
    user: req.user
  });
});

// ==========================================
// PROTECTED BUSINESS ROUTES
// ==========================================

// Health check route
app.get('/', (req, res) => {
  res.send('Server is running');
});

// RECORD ATTENDANCE VIA QR (ADMIN or SYSTEM)
app.post('/api/attendance/scan', authenticateToken, requireRole('ADMIN'), async (req, res) => {
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

// GET CLEARANCE STATUS (Any logged-in user can check clearance)
app.get('/api/clearance/:student_id', authenticateToken, async (req, res) => {
  const { student_id } = req.params;

  // If role is STUDENT, ensure they only check their own clearance
  if (req.user.role === 'STUDENT' && req.user.student_id !== student_id) {
    return res.status(403).json({ success: false, message: 'Unauthorized to view clearance of other students.' });
  }

  try {
    const totalEventsQuery = await pool.query(
      'SELECT COUNT(*) FROM events WHERE is_mandatory = true'
    );
    const totalMandatoryEvents = parseInt(totalEventsQuery.rows[0].count);

    const attendedQuery = await pool.query(
      `SELECT COUNT(DISTINCT a.event_id) 
       FROM attendance a 
       JOIN events e ON a.event_id = e.event_id 
       WHERE a.student_id = $1 AND e.is_mandatory = true`,
      [student_id]
    );
    const attendedEvents = parseInt(attendedQuery.rows[0].count);

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

// FETCH ALL EVENTS (ADMIN & STUDENT)
app.get('/api/events', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM events ORDER BY event_date ASC');
    res.json({
      success: true,
      data: result.rows
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Database error' });
  }
});

// CREATE A NEW EVENT (ADMIN ONLY)
app.post('/api/events', authenticateToken, requireRole('ADMIN'), async (req, res) => {
  const { event_name, event_date, semester, academic_year, is_mandatory } = req.body;

  if (!event_name || !event_date) {
    return res.status(400).json({ 
      success: false, 
      message: 'Event name and date are required.' 
    });
  }

  try {
    const result = await pool.query(
      `INSERT INTO events (event_name, event_date, semester, academic_year, is_mandatory)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [event_name, event_date, semester, academic_year, is_mandatory]
    );

    res.status(201).json({
      success: true,
      message: 'Event created successfully!',
      data: result.rows[0]
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Database error' });
  }
});

// DELETE AN EVENT (ADMIN ONLY)
app.delete('/api/events/:event_id', authenticateToken, requireRole('ADMIN'), async (req, res) => {
  const { event_id } = req.params;

  try {
    const result = await pool.query(
      'DELETE FROM events WHERE event_id = $1 RETURNING *',
      [event_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Event not found.' });
    }

    res.json({
      success: true,
      message: `Event ID ${event_id} deleted successfully!`,
      deleted_event: result.rows[0]
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Database error' });
  }
});

// EXPORT ALL OR FILTERED STUDENTS AS CSV (ADMIN ONLY)
app.get('/api/students/export', authenticateToken, requireRole('ADMIN'), async (req, res) => {
  const { section, department, year_level, mentor } = req.query;

  try {
    let query = 'SELECT student_id, first_name, last_name, year_level, department, email, section, mentor FROM students';
    let params = [];
    let conditions = [];

    if (section) { params.push(section); conditions.push(`section = $${params.length}`); }
    if (department) { params.push(department); conditions.push(`department = $${params.length}`); }
    if (year_level) { params.push(year_level); conditions.push(`year_level = $${params.length}`); }
    if (mentor) { params.push(mentor); conditions.push(`mentor = $${params.length}`); }

    if (conditions.length > 0) { query += ' WHERE ' + conditions.join(' AND '); }
    query += ' ORDER BY student_id ASC';

    const result = await pool.query(query, params);

    const json2csvParser = new Parser();
    const csvData = json2csvParser.parse(result.rows);

    res.header('Content-Type', 'text/csv');
    res.attachment(`students_export_${Date.now()}.csv`);
    return res.send(csvData);

  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Failed to generate CSV export' });
  }
});

// FETCH ALL STUDENTS (ADMIN ONLY)
app.get('/api/students', authenticateToken, requireRole('ADMIN'), async (req, res) => {
  const { section, department, year_level, mentor } = req.query;

  try {
    let query = 'SELECT * FROM students';
    let params = [];
    let conditions = [];

    if (section) { params.push(section); conditions.push(`section = $${params.length}`); }
    if (department) { params.push(department); conditions.push(`department = $${params.length}`); }
    if (year_level) { params.push(year_level); conditions.push(`year_level = $${params.length}`); }
    if (mentor) { params.push(mentor); conditions.push(`mentor = $${params.length}`); }

    if (conditions.length > 0) { query += ' WHERE ' + conditions.join(' AND '); }
    query += ' ORDER BY student_id ASC';

    const result = await pool.query(query, params);
    res.json({
      success: true,
      data: result.rows
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Database error' });
  }
});

// BULK REGISTER/UPDATE STUDENTS (ADMIN ONLY)
app.post('/api/students/bulk', authenticateToken, requireRole('ADMIN'), async (req, res) => {
  const { students } = req.body;

  if (!students || !Array.isArray(students) || students.length === 0) {
    return res.status(400).json({ success: false, message: 'An array of students is required.' });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const insertedStudents = [];

    for (const student of students) {
      const { student_id, first_name, last_name, year_level, department, email, qr_code_hash, section, mentor } = student;

      const result = await client.query(
        `INSERT INTO students (student_id, first_name, last_name, year_level, department, email, qr_code_hash, section, mentor)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (student_id) DO UPDATE 
         SET first_name = EXCLUDED.first_name,
             last_name = EXCLUDED.last_name,
             year_level = EXCLUDED.year_level,
             department = EXCLUDED.department,
             email = EXCLUDED.email,
             section = EXCLUDED.section,
             mentor = EXCLUDED.mentor
         RETURNING *`,
        [student_id, first_name, last_name, year_level, department, email, qr_code_hash, section, mentor]
      );
      insertedStudents.push(result.rows[0]);
    }

    await client.query('COMMIT');

    res.status(201).json({
      success: true,
      message: `Successfully processed ${insertedStudents.length} students!`,
      data: insertedStudents
    });

  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ success: false, error: 'Database error during bulk insert' });
  } finally {
    client.release();
  }
});

// REGISTER A NEW STUDENT (ADMIN ONLY)
app.post('/api/students', authenticateToken, requireRole('ADMIN'), async (req, res) => {
  const { student_id, first_name, last_name, year_level, department, email, qr_code_hash, section, mentor } = req.body;

  if (!student_id || !first_name || !last_name || !year_level || !department || !email || !qr_code_hash) {
    return res.status(400).json({
      success: false,
      message: 'Core fields (student_id, first_name, last_name, year_level, department, email, qr_code_hash) are required.'
    });
  }

  try {
    const result = await pool.query(
      `INSERT INTO students (student_id, first_name, last_name, year_level, department, email, qr_code_hash, section, mentor)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [student_id, first_name, last_name, year_level, department, email, qr_code_hash, section, mentor]
    );

    res.status(201).json({
      success: true,
      message: 'Student registered successfully!',
      data: result.rows[0]
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Database error' });
  }
});

// UPDATE A STUDENT BY ID (ADMIN ONLY)
app.put('/api/students/:student_id', authenticateToken, requireRole('ADMIN'), async (req, res) => {
  const { student_id } = req.params;
  const { first_name, last_name, year_level, department, email, section, mentor } = req.body;

  try {
    const result = await pool.query(
      `UPDATE students 
       SET first_name = COALESCE($1, first_name),
           last_name = COALESCE($2, last_name),
           year_level = COALESCE($3, year_level),
           department = COALESCE($4, department),
           email = COALESCE($5, email),
           section = COALESCE($6, section),
           mentor = COALESCE($7, mentor)
       WHERE student_id = $8
       RETURNING *`,
      [first_name, last_name, year_level, department, email, section, mentor, student_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Student not found.' });
    }

    res.json({
      success: true,
      message: 'Student updated successfully!',
      data: result.rows[0]
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Database error' });
  }
});

// DELETE A STUDENT BY ID (ADMIN ONLY)
app.delete('/api/students/:student_id', authenticateToken, requireRole('ADMIN'), async (req, res) => {
  const { student_id } = req.params;

  try {
    const result = await pool.query(
      'DELETE FROM students WHERE student_id = $1 RETURNING *',
      [student_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Student not found.' });
    }

    res.json({
      success: true,
      message: `Student ${student_id} deleted successfully!`,
      deleted_student: result.rows[0]
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Database error' });
  }
});

// START THE SERVER
app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});