
const db = require("./database");

const users = [
    {
        name: "Kashish Mishra",
        user_id: "student001",
        password: "student123",
        role: "student"
    },
    {
        name: "Aarav Sharma",
        user_id: "student002",
        password: "student123",
        role: "student"
    },
    {
        name: "Priya Verma",
        user_id: "student003",
        password: "student123",
        role: "student"
    },
    {
        name: "Hostel Management",
        user_id: "admin001",
        password: "admin123",
        role: "management"
    },
    {
        name: "Raj Kumar",
        user_id: "worker001",
        password: "worker123",
        role: "worker"
    }
];

const insertUser = db.prepare(`
    INSERT OR IGNORE INTO users (name, user_id, password, role)
    VALUES (?, ?, ?, ?)
`);

for (const user of users) {
    insertUser.run(
        user.name,
        user.user_id,
        user.password,
        user.role
    );
}

console.log("Users added successfully!");
