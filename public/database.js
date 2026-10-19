const Database = require("better-sqlite3");

const db = new Database("fixmyhostel.db");

db.exec(`
    CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        user_id TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        role TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS complaints (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        complaint_id TEXT UNIQUE NOT NULL,
        student_id INTEGER NOT NULL,
        room_number TEXT NOT NULL,
        category TEXT NOT NULL,
        description TEXT NOT NULL,
        preferred_time TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'Submitted',
        assigned_worker INTEGER,
        scheduled_time TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (student_id) REFERENCES users(id),
        FOREIGN KEY (assigned_worker) REFERENCES users(id)
    );
`);

console.log("Database connected successfully!");

module.exports = db;