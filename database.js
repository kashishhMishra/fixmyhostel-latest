
const Database = require("better-sqlite3");

const db = new Database("fixmyhostel.db");

// Create the original tables if they do not exist.
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

// Add new complaint columns only when they are missing.
// This preserves existing complaint records.
const existingColumns = db
    .prepare("PRAGMA table_info(complaints)")
    .all()
    .map(column => column.name);

const newColumns = [
    ["priority", "TEXT NOT NULL DEFAULT 'Medium'"],
    ["attachment_path", "TEXT"],
    ["attachment_type", "TEXT"]
];

for (const [name, definition] of newColumns) {
    if (!existingColumns.includes(name)) {
        db.exec(`ALTER TABLE complaints ADD COLUMN ${name} ${definition}`);
    }
}

// Store in-app notifications.
db.exec(`
    CREATE TABLE IF NOT EXISTS notifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        complaint_id TEXT,
        message TEXT NOT NULL,
        is_read INTEGER NOT NULL DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS feedback (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        complaint_id TEXT UNIQUE NOT NULL,
        student_id INTEGER NOT NULL,
        rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
        comment TEXT DEFAULT '',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (student_id) REFERENCES users(id),
        FOREIGN KEY (complaint_id) REFERENCES complaints(complaint_id)
    );
`);

console.log("Database connected successfully!");

module.exports = db;
