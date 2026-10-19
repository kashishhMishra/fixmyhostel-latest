const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const multer = require("multer");
const db = require("./database");

const app = express();
const PORT = 3000;

const uploadDir = path.join(__dirname, "uploads");
fs.mkdirSync(uploadDir, { recursive: true });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));
app.use("/css", express.static(path.join(__dirname, "css")));
app.use("/uploads", express.static(uploadDir));

// Add new columns safely. Existing complaints and photos are preserved.
const columns = db.prepare("PRAGMA table_info(complaints)")
    .all()
    .map(column => column.name);

if (!columns.includes("priority")) {
    db.exec("ALTER TABLE complaints ADD COLUMN priority TEXT DEFAULT 'Medium'");
}
if (!columns.includes("attachment_path")) {
    db.exec("ALTER TABLE complaints ADD COLUMN attachment_path TEXT");
}
if (!columns.includes("attachment_type")) {
    db.exec("ALTER TABLE complaints ADD COLUMN attachment_type TEXT");
}
if (!columns.includes("completion_photo_path")) {
    db.exec("ALTER TABLE complaints ADD COLUMN completion_photo_path TEXT");
}
if (!columns.includes("completion_photo_type")) {
    db.exec("ALTER TABLE complaints ADD COLUMN completion_photo_type TEXT");
}

const allowedTypes = new Set([
    "image/jpeg", "image/png", "image/webp", "image/gif",
    "video/mp4", "video/webm", "video/quicktime"
]);

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => {
        cb(null, crypto.randomUUID() + path.extname(file.originalname).toLowerCase());
    }
});

const upload = multer({
    storage,
    limits: { fileSize: 50 * 1024 * 1024, files: 1 },
    fileFilter: (req, file, cb) => {
        if (allowedTypes.has(file.mimetype)) cb(null, true);
        else cb(new Error("Upload a JPG, PNG, WEBP, GIF, MP4, WEBM, or MOV file."));
    }
});

function notify(userId, complaintId, message) {
    if (!userId) return;
    db.prepare(`
        INSERT INTO notifications (user_id, complaint_id, message)
        VALUES (?, ?, ?)
    `).run(userId, complaintId, message);
}

function isManager(userId) {
    return db.prepare(`
        SELECT id FROM users
        WHERE id = ? AND LOWER(role) IN ('manager', 'management', 'admin')
    `).get(Number(userId));
}

function getComplaints(query = {}) {
    let sql = `
        SELECT c.complaint_id, c.student_id, c.room_number,
               c.category, c.description, c.preferred_time,
               c.scheduled_time, c.status, c.created_at,
               COALESCE(c.priority, 'Medium') AS priority,
               c.attachment_path, c.attachment_type,
               c.completion_photo_path, c.completion_photo_type,
               c.assigned_worker,
               student.name AS student_name,
               worker.name AS worker_name
        FROM complaints c
        JOIN users student ON c.student_id = student.id
        LEFT JOIN users worker ON c.assigned_worker = worker.id
        WHERE 1 = 1
    `;
    const params = [];

    if (query.search) {
        sql += ` AND (
            c.complaint_id LIKE ? OR c.room_number LIKE ? OR
            c.category LIKE ? OR c.description LIKE ? OR
            student.name LIKE ?
        )`;
        const term = `%${String(query.search).slice(0, 100)}%`;
        params.push(term, term, term, term, term);
    }

    for (const field of ["status", "category", "priority"]) {
        if (query[field]) {
            if (field === "status" && ![
                "Submitted", "Scheduled", "In Progress",
                "Verification Pending", "Resolved"
            ].includes(query.status)) continue;

            if (field === "priority" && ![
                "Low", "Medium", "High", "Urgent"
            ].includes(query.priority)) continue;

            sql += ` AND c.${field} = ?`;
            params.push(String(query[field]).slice(0, 100));
        }
    }

    sql += `
        ORDER BY
          CASE COALESCE(c.priority, 'Medium')
            WHEN 'Urgent' THEN 1
            WHEN 'High' THEN 2
            WHEN 'Medium' THEN 3
            ELSE 4
          END,
          c.created_at DESC
    `;

    return db.prepare(sql).all(...params);
}

// LOGIN
app.post("/login", (req, res) => {
    const { user_id, password } = req.body || {};

    if (!user_id || !password) {
        return res.status(400).json({
            success: false,
            message: "Enter your ID and password."
        });
    }

    const user = db.prepare(`
        SELECT id, name, user_id, role
        FROM users
        WHERE user_id = ? AND password = ?
    `).get(user_id, password);

    if (!user) {
        return res.status(401).json({
            success: false,
            message: "Invalid ID or password."
        });
    }

    res.json({ success: true, user });
});

// STUDENT SUBMITS A COMPLAINT AND OPTIONAL PHOTO/VIDEO
app.post("/complaints", (req, res) => {
    upload.single("attachment")(req, res, error => {
        if (error) {
            return res.status(400).json({
                success: false,
                message: error.message || "Upload failed."
            });
        }

        try {
            const {
                student_id, room_number, category,
                description, preferred_time, priority
            } = req.body || {};

            const studentId = Number(student_id);
            const student = db.prepare(`
                SELECT id FROM users WHERE id = ? AND role = 'student'
            `).get(studentId);

            if (!student) {
                if (req.file) fs.unlinkSync(req.file.path);
                return res.status(400).json({
                    success: false,
                    message: "Valid student account required."
                });
            }

            if (!room_number || !category || !description || !preferred_time) {
                if (req.file) fs.unlinkSync(req.file.path);
                return res.status(400).json({
                    success: false,
                    message: "Please complete all required fields."
                });
            }

            const validPriorities = ["Low", "Medium", "High", "Urgent"];
            const chosenPriority = priority || "Medium";

            if (!validPriorities.includes(chosenPriority)) {
                if (req.file) fs.unlinkSync(req.file.path);
                return res.status(400).json({
                    success: false,
                    message: "Choose a valid priority."
                });
            }

            const complaintId =
                "FMH" + Date.now() + crypto.randomBytes(2).toString("hex");

            db.prepare(`
                INSERT INTO complaints (
                    complaint_id, student_id, room_number, category,
                    description, preferred_time, priority,
                    attachment_path, attachment_type
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
                complaintId, studentId,
                String(room_number).trim(),
                String(category).trim(),
                String(description).trim(),
                String(preferred_time),
                chosenPriority,
                req.file ? "/uploads/" + req.file.filename : null,
                req.file ? req.file.mimetype : null
            );

            // Alert management that a new request is waiting.
            const managers = db.prepare(`
                SELECT id FROM users
                WHERE LOWER(role) IN ('manager', 'management', 'admin')
            `).all();

            for (const manager of managers) {
                notify(
                    manager.id,
                    complaintId,
                    `New ${chosenPriority} priority complaint: ${complaintId}.`
                );
            }

            res.status(201).json({
                success: true,
                complaint_id: complaintId,
                message: "Complaint submitted successfully."
            });
        } catch (error) {
            if (req.file && fs.existsSync(req.file.path)) {
                fs.unlinkSync(req.file.path);
            }
            console.error(error);
            res.status(500).json({
                success: false,
                message: "Could not save the complaint."
            });
        }
    });
});

// STUDENT COMPLAINTS
app.get("/complaints/student/:studentId", (req, res) => {
    const studentId = Number(req.params.studentId);

    if (!Number.isInteger(studentId) || studentId < 1) {
        return res.status(400).json([]);
    }

    const complaints = db.prepare(`
        SELECT c.complaint_id, c.student_id, c.room_number, c.category,
               c.description, c.preferred_time, c.scheduled_time,
               c.status, c.created_at, COALESCE(c.priority, 'Medium') AS priority,
               c.attachment_path, c.attachment_type,
               c.completion_photo_path, c.completion_photo_type,
               worker.name AS worker_name,
               f.rating AS feedback_rating, f.comment AS feedback_comment
        FROM complaints c
        LEFT JOIN users worker ON c.assigned_worker = worker.id
        LEFT JOIN feedback f ON f.complaint_id = c.complaint_id
        WHERE c.student_id = ?
        ORDER BY c.created_at DESC
    `).all(studentId);

    res.json(complaints);
});

// MANAGER ASSIGNS A WORKER AND SCHEDULES A VISIT
app.post("/complaints/:complaintId/assign", (req, res) => {
    const { complaintId } = req.params;
    const { worker_id, scheduled_time, manager_id } = req.body || {};

    if (!isManager(manager_id)) {
        return res.status(403).json({
            success: false,
            message: "Only management can assign complaints."
        });
    }

    const complaint = db.prepare(`
        SELECT * FROM complaints WHERE complaint_id = ?
    `).get(complaintId);

    if (!complaint) {
        return res.status(404).json({
            success: false,
            message: "Complaint not found."
        });
    }

    if (["Resolved", "Verification Pending"].includes(complaint.status)) {
        return res.status(400).json({
            success: false,
            message: "This complaint cannot be assigned in its current status."
        });
    }

    const worker = db.prepare(`
        SELECT id, name, user_id FROM users
        WHERE id = ? AND role = 'worker'
    `).get(Number(worker_id));

    if (!worker || !scheduled_time) {
        return res.status(400).json({
            success: false,
            message: "Select a valid worker and visit time."
        });
    }

    db.prepare(`
        UPDATE complaints
        SET assigned_worker = ?, scheduled_time = ?, status = 'Scheduled'
        WHERE complaint_id = ?
    `).run(worker.id, scheduled_time, complaintId);

    notify(
        complaint.student_id,
        complaintId,
        `Your complaint ${complaintId} has been assigned to ${worker.name} and scheduled for ${scheduled_time}.`
    );

    notify(
        worker.id,
        complaintId,
        `A complaint has been assigned to you: ${complaintId}.`
    );

    res.json({
        success: true,
        message: "Worker assigned and visit scheduled successfully."
    });
});

// WORKERS LIST
app.get("/workers", (req, res) => {
    res.json(db.prepare(`
        SELECT id, name, user_id FROM users WHERE role = 'worker'
    `).all());
});

// MANAGER COMPLAINT LIST
app.get("/complaints", (req, res) => {
    res.json(getComplaints(req.query));
});

// WORKER'S ASSIGNED COMPLAINTS
app.get("/complaints/worker/:workerId", (req, res) => {
    const workerId = Number(req.params.workerId);

    if (!Number.isInteger(workerId) || workerId < 1) {
        return res.status(400).json([]);
    }

    const worker = db.prepare(`
        SELECT id FROM users WHERE id = ? AND role = 'worker'
    `).get(workerId);

    if (!worker) return res.status(403).json([]);

    const complaints = db.prepare(`
        SELECT c.complaint_id, c.student_id, c.room_number, c.category,
               c.description, c.preferred_time, c.scheduled_time,
               c.status, c.created_at, COALESCE(c.priority, 'Medium') AS priority,
               c.attachment_path, c.attachment_type,
               c.completion_photo_path, c.completion_photo_type,
               student.name AS student_name
        FROM complaints c
        JOIN users student ON c.student_id = student.id
        WHERE c.assigned_worker = ?
        ORDER BY c.created_at DESC
    `).all(workerId);

    res.json(complaints);
});

// WORKER STARTS THE REPAIR
app.patch("/complaints/:complaintId/start", (req, res) => {
    const { complaintId } = req.params;
    const workerId = Number((req.body || {}).worker_id);

    const complaint = db.prepare(`
        SELECT * FROM complaints WHERE complaint_id = ?
    `).get(complaintId);

    if (!complaint || Number(complaint.assigned_worker) !== workerId) {
        return res.status(403).json({
            success: false,
            message: "This complaint is not assigned to this worker."
        });
    }

    if (!["Scheduled", "In Progress"].includes(complaint.status)) {
        return res.status(400).json({
            success: false,
            message: "This complaint cannot be started in its current status."
        });
    }

    db.prepare(`
        UPDATE complaints SET status = 'In Progress'
        WHERE complaint_id = ?
    `).run(complaintId);

    notify(
        complaint.student_id,
        complaintId,
        `Work has started on complaint ${complaintId}.`
    );

    res.json({ success: true, status: "In Progress" });
});

// WORKER SUBMITS A SEPARATE AFTER-REPAIR PHOTO
app.post("/complaints/:complaintId/completion-proof", (req, res) => {
    upload.single("completion_photo")(req, res, error => {
        if (error) {
            return res.status(400).json({
                success: false,
                message: error.message || "Upload failed."
            });
        }

        try {
            const { complaintId } = req.params;
            const workerId = Number((req.body || {}).worker_id);

            if (!req.file) {
                return res.status(400).json({
                    success: false,
                    message: "Upload a photo of the completed repair."
                });
            }

            const complaint = db.prepare(`
                SELECT * FROM complaints WHERE complaint_id = ?
            `).get(complaintId);

            if (!complaint || Number(complaint.assigned_worker) !== workerId) {
                fs.unlinkSync(req.file.path);
                return res.status(403).json({
                    success: false,
                    message: "This complaint is not assigned to this worker."
                });
            }

            if (complaint.status !== "In Progress") {
                fs.unlinkSync(req.file.path);
                return res.status(400).json({
                    success: false,
                    message: "Start the repair before submitting completion proof."
                });
            }

            db.prepare(`
                UPDATE complaints
                SET completion_photo_path = ?,
                    completion_photo_type = ?,
                    status = 'Verification Pending'
                WHERE complaint_id = ?
            `).run(
                "/uploads/" + req.file.filename,
                req.file.mimetype,
                complaintId
            );

            const managers = db.prepare(`
                SELECT id FROM users
                WHERE LOWER(role) IN ('manager', 'management', 'admin')
            `).all();

            for (const manager of managers) {
                notify(
                    manager.id,
                    complaintId,
                    `Completion proof submitted for ${complaintId}. Please review it.`
                );
            }

            notify(
                complaint.student_id,
                complaintId,
                `The worker submitted completion proof for ${complaintId}. It is awaiting manager verification.`
            );

            res.json({
                success: true,
                status: "Verification Pending",
                message: "Proof submitted. The manager must verify the repair."
            });
        } catch (error) {
            if (req.file && fs.existsSync(req.file.path)) {
                fs.unlinkSync(req.file.path);
            }
            console.error(error);
            res.status(500).json({
                success: false,
                message: "Could not submit completion proof."
            });
        }
    });
});

// ONLY MANAGEMENT CAN APPROVE OR RETURN COMPLETION PROOF
app.patch("/complaints/:complaintId/status", (req, res) => {
    const { complaintId } = req.params;
    const { status, manager_id } = req.body || {};

    if (!isManager(manager_id)) {
        return res.status(403).json({
            success: false,
            message: "Only management can approve or return a complaint."
        });
    }

    if (!["In Progress", "Resolved"].includes(status)) {
        return res.status(400).json({
            success: false,
            message: "Invalid status."
        });
    }

    const complaint = db.prepare(`
        SELECT * FROM complaints WHERE complaint_id = ?
    `).get(complaintId);

    if (!complaint) {
        return res.status(404).json({
            success: false,
            message: "Complaint not found."
        });
    }

    if (status === "Resolved") {
        if (complaint.status !== "Verification Pending" ||
            !complaint.completion_photo_path) {
            return res.status(400).json({
                success: false,
                message: "The worker must submit completion proof before approval."
            });
        }
    } else if (complaint.status !== "Verification Pending") {
        return res.status(400).json({
            success: false,
            message: "Only a complaint awaiting verification can be returned."
        });
    }

    db.prepare(`
        UPDATE complaints SET status = ? WHERE complaint_id = ?
    `).run(status, complaintId);

    notify(
        complaint.student_id,
        complaintId,
        status === "Resolved"
            ? `Your complaint ${complaintId} has been verified and resolved by management.`
            : `The completion proof for ${complaintId} was not approved. Further work is required.`
    );

    if (complaint.assigned_worker) {
        notify(
            complaint.assigned_worker,
            complaintId,
            status === "Resolved"
                ? `Management approved your completion proof for ${complaintId}.`
                : `Management returned ${complaintId} for further work.`
        );
    }

    res.json({
        success: true,
        status,
        message: status === "Resolved"
            ? "Completion proof approved."
            : "Complaint returned for further work."
    });
});

// NOTIFICATIONS
app.get("/notifications/:userId", (req, res) => {
    const userId = Number(req.params.userId);

    if (!Number.isInteger(userId) || userId < 1) {
        return res.status(400).json([]);
    }

    res.json(db.prepare(`
        SELECT id, complaint_id, message, is_read, created_at
        FROM notifications
        WHERE user_id = ?
        ORDER BY created_at DESC
        LIMIT 100
    `).all(userId));
});

app.patch("/notifications/:notificationId/read", (req, res) => {
    const result = db.prepare(`
        UPDATE notifications SET is_read = 1 WHERE id = ?
    `).run(Number(req.params.notificationId));

    res.json({ success: result.changes > 0 });
});

// STUDENT FEEDBACK
app.post("/complaints/:complaintId/feedback", (req, res) => {
    const { complaintId } = req.params;
    const { student_id, rating, comment } = req.body || {};
    const studentId = Number(student_id);
    const numericRating = Number(rating);

    const complaint = db.prepare(`
        SELECT * FROM complaints WHERE complaint_id = ?
    `).get(complaintId);

    if (!complaint || Number(complaint.student_id) !== studentId) {
        return res.status(404).json({
            success: false,
            message: "Complaint not found for this student."
        });
    }

    if (complaint.status !== "Resolved") {
        return res.status(400).json({
            success: false,
            message: "Feedback is available after the complaint is resolved."
        });
    }

    if (!Number.isInteger(numericRating) || numericRating < 1 || numericRating > 5) {
        return res.status(400).json({
            success: false,
            message: "Rating must be between 1 and 5."
        });
    }

    try {
        db.prepare(`
            INSERT INTO feedback (complaint_id, student_id, rating, comment)
            VALUES (?, ?, ?, ?)
        `).run(
            complaintId,
            studentId,
            numericRating,
            String(comment || "").trim().slice(0, 1000)
        );

        res.status(201).json({
            success: true,
            message: "Thank you for your feedback!"
        });
    } catch (error) {
        if (String(error.code || "").startsWith("SQLITE_CONSTRAINT")) {
            return res.status(409).json({
                success: false,
                message: "Feedback has already been submitted."
            });
        }

        console.error(error);
        res.status(500).json({
            success: false,
            message: "Could not save feedback."
        });
    }
});

// UPLOAD/UNEXPECTED ERRORS
app.use((err, req, res, next) => {
    console.error(err);
    res.status(400).json({
        success: false,
        message: err.message || "Something went wrong."
    });
});

app.listen(PORT, () => {
    console.log(`FixMyHostel server running on http://localhost:${PORT}`);
});