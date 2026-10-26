require("dotenv").config();

const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const express = require("express");
const nodemailer = require("nodemailer");
const { Pool } = require("pg");
const sqlServer = require("mssql");

const requiredSettings = ["DB_HOST", "DB_NAME", "DB_USER", "DB_PASSWORD"];
const missingSettings = requiredSettings.filter(name => !process.env[name]);
if (missingSettings.length) {
  console.error(`Missing database settings: ${missingSettings.join(", ")}. Copy .env.example to .env and set them.`);
  process.exit(1);
}

const pool = new Pool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 5432),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  ssl: { rejectUnauthorized: false },
  max: 8,
  connectionTimeoutMillis: 5000
});
const coreDatabaseSettings = ["CORE_DB_HOST", "CORE_DB_NAME", "CORE_DB_USER", "CORE_DB_PASSWORD", "CORE_DB_CUSTOMER_VIEW"];
const coreDatabaseConfigured = coreDatabaseSettings.every(name => process.env[name]);
const corePool = coreDatabaseConfigured ? new sqlServer.ConnectionPool({
  server: process.env.CORE_DB_HOST,
  port: Number(process.env.CORE_DB_PORT || 1433),
  database: process.env.CORE_DB_NAME,
  user: process.env.CORE_DB_USER,
  password: process.env.CORE_DB_PASSWORD,
  connectionTimeout: 5000,
  requestTimeout: 15000,
  options: {
    encrypt: process.env.CORE_DB_ENCRYPT === "true" || process.env.CORE_DB_SSL === "true",
    trustServerCertificate: process.env.CORE_DB_TRUST_SERVER_CERTIFICATE === "true"
  },
  pool: { max: 3, min: 0, idleTimeoutMillis: 30000 }
}) : null;
const app = express();
app.use(express.json({ limit: "20mb" }));
app.use("/sample-files", express.static(path.join(__dirname, "sample-files"), { index: false }));

function validDate(value) {
  const match = String(value || "").match(/^\d{4}-\d{2}-\d{2}/);
  return match ? match[0] : null;
}

async function initializeSchema() {
  const schema = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
  await pool.query(schema);
}

function attachmentMediaType(fileName, mediaType) {
  if (mediaType && mediaType !== "application/octet-stream") return mediaType;
  const fallbackTypes = {
    ".pdf": "application/pdf",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".bmp": "image/bmp",
    ".avif": "image/avif"
  };
  return fallbackTypes[path.extname(fileName).toLowerCase()] || mediaType || "application/octet-stream";
}

app.get("/", (request, response) => response.sendFile(path.join(__dirname, "index.html")));

app.get("/api/health", async (request, response, next) => {
  try {
    const { rows } = await pool.query("SELECT current_database() AS database, current_user AS user");
    response.json({ status: "ok", ...rows[0] });
  } catch (error) { next(error); }
});

function quoteSqlServerIdentifier(value) {
  const parts = String(value || "").split(".");
  if (!parts.length || parts.some(part => !/^[A-Za-z0-9_$]+$/.test(part))) throw new Error("Invalid Core Banking view configuration");
  return parts.map(part => `[${part}]`).join(".");
}

app.get("/api/core-banking/customers", async (request, response) => {
  if (!corePool) {
    response.status(503).json({ error: "Core Banking lookup is not configured on the server." });
    return;
  }
  const lookupType = request.query.lookupType;
  const lookupValue = String(request.query.value || "").trim();
  if (!["nationalId", "accountId"].includes(lookupType) || !lookupValue || lookupValue.length > 128) {
    response.status(400).json({ error: "Choose National ID or Account ID and enter a valid search value." });
    return;
  }
  try {
    const view = quoteSqlServerIdentifier(process.env.CORE_DB_CUSTOMER_VIEW);
    const columnName = lookupType === "nationalId"
      ? process.env.CORE_DB_NATIONAL_ID_COLUMN || "national_id"
      : process.env.CORE_DB_ACCOUNT_ID_COLUMN || "account_id";
    const column = quoteSqlServerIdentifier(columnName);
    const mappedColumns = {
      name: process.env.CORE_DB_CUSTOMER_NAME_COLUMN || "full_name",
      nationalId: process.env.CORE_DB_NATIONAL_ID_COLUMN || "national_id",
      accountId: process.env.CORE_DB_ACCOUNT_ID_COLUMN || "account_id",
      phone: process.env.CORE_DB_PHONE_COLUMN || "phone",
      email: process.env.CORE_DB_EMAIL_COLUMN || "email",
      outstandingBalance: process.env.CORE_DB_LOAN_BALANCE_COLUMN || "outstanding_balance"
    };
    const aliases = Object.entries(mappedColumns).map(([key, name]) => `${quoteSqlServerIdentifier(name)} AS [__${key}]`).join(", ");
    const customerResult = await corePool.request()
      .input("lookupValue", sqlServer.NVarChar(128), lookupValue)
      .query(`SELECT TOP (20) *, ${aliases} FROM ${view} WHERE ${column} = @lookupValue`);
    const rows = customerResult.recordset;
    const paymentViewName = process.env.CORE_DB_PAYMENT_VIEW;
    const customers = await Promise.all(rows.map(async row => {
      const customer = Object.fromEntries(Object.keys(mappedColumns).map(key => [key, row[`__${key}`] ?? ""]));
      let payments = [];
      if (paymentViewName && customer.accountId) {
        const paymentView = quoteSqlServerIdentifier(paymentViewName);
        const paymentAccountColumn = quoteSqlServerIdentifier(process.env.CORE_DB_PAYMENT_ACCOUNT_COLUMN || mappedColumns.accountId);
        const paymentColumns = {
          paymentDate: process.env.CORE_DB_PAYMENT_DATE_COLUMN || "payment_date",
          amount: process.env.CORE_DB_PAYMENT_AMOUNT_COLUMN || "amount",
          reference: process.env.CORE_DB_PAYMENT_REFERENCE_COLUMN || "reference"
        };
        const paymentAliases = Object.entries(paymentColumns).map(([key, name]) => `${quoteSqlServerIdentifier(name)} AS [__${key}]`).join(", ");
        const paymentResult = await corePool.request()
          .input("accountId", sqlServer.NVarChar(128), String(customer.accountId))
          .query(`SELECT TOP (100) *, ${paymentAliases} FROM ${paymentView} WHERE ${paymentAccountColumn} = @accountId ORDER BY ${quoteSqlServerIdentifier(paymentColumns.paymentDate)} DESC`);
        const paymentRows = paymentResult.recordset;
        payments = paymentRows.map(payment => ({
          fields: Object.fromEntries(Object.entries(payment).filter(([key]) => !key.startsWith("__"))),
          paymentDate: payment.__paymentDate ?? null,
          amount: Number(payment.__amount) || 0,
          reference: payment.__reference ?? ""
        }));
      }
      return {
        fields: Object.fromEntries(Object.entries(row).filter(([key]) => !key.startsWith("__"))),
        customer: { ...customer, payments, paymentHistoryAvailable: Boolean(paymentViewName) }
      };
    }));
    response.json({ customers });
  } catch (error) {
    console.error("Core Banking lookup failed:", error.code || error.message);
    response.status(503).json({ error: "Core Banking is unreachable or the configured lookup view is unavailable." });
  }
});

app.get("/api/data", async (request, response, next) => {
  try {
    const [applicationRows, customerRows, messageRows, userRows, attachmentRows] = await Promise.all([
      pool.query("SELECT record FROM loan_applications ORDER BY submitted_on DESC NULLS LAST, application_id"),
      pool.query("SELECT profile FROM customers ORDER BY full_name, customer_id"),
      pool.query("SELECT record FROM team_messages WHERE recipient_username IS NULL ORDER BY created_at, message_id"),
      pool.query("SELECT account FROM system_users ORDER BY full_name, email"),
      pool.query("SELECT attachment_id, file_name FROM loan_attachments")
    ]);
    response.json({
      applications: applicationRows.rows.map(row => row.record),
      customers: customerRows.rows.map(row => row.profile),
      messages: messageRows.rows.map(row => row.record),
      users: userRows.rows.map(row => row.account),
      attachments: attachmentRows.rows.map(row => ({ id: row.attachment_id, name: row.file_name }))
    });
  } catch (error) { next(error); }
});

app.get("/api/chat/state", async (request, response, next) => {
  const email = String(request.query.email || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    response.status(400).json({ error: "A valid account email is required to load chat." });
    return;
  }
  try {
    const [messageRows, presenceRows] = await Promise.all([
      pool.query(`SELECT record FROM team_messages
                  WHERE recipient_username IS NULL OR sender_username = $1 OR recipient_username = $1
                  ORDER BY created_at, message_id`, [email]),
      pool.query(`SELECT email, BOOL_OR(is_online AND last_seen_at > NOW() - INTERVAL '60 seconds') AS is_online,
                         MAX(last_seen_at) AS last_seen_at
                  FROM team_chat_presence GROUP BY email`)
    ]);
    response.json({ messages: messageRows.rows.map(row => row.record), presence: presenceRows.rows });
  } catch (error) { next(error); }
});

function validCallIdentity(email, callId) {
  return typeof email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) &&
    typeof callId === "string" && /^[a-zA-Z0-9_-]{8,80}$/.test(callId);
}

async function registeredCallUser(email) {
  const { rows } = await pool.query("SELECT email FROM system_users WHERE LOWER(email) = LOWER($1) LIMIT 1", [email]);
  return rows[0]?.email?.toLowerCase() || null;
}

app.post("/api/calls/:callId/join", async (request, response, next) => {
  const email = String(request.body?.email || "").trim().toLowerCase();
  const roomKey = String(request.body?.roomKey || "").trim();
  const create = request.body?.create === true;
  if (!validCallIdentity(email, request.params.callId) || !roomKey || roomKey.length > 180) {
    response.status(400).json({ error: "A valid account, call ID, and chat room are required." });
    return;
  }
  try {
    if (!await registeredCallUser(email)) {
      response.status(403).json({ error: "Only a registered team member can join a call." });
      return;
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      if (create) {
        await client.query(
          "INSERT INTO team_calls (call_id, room_key, created_by) VALUES ($1, $2, $3) ON CONFLICT (call_id) DO NOTHING",
          [request.params.callId, roomKey, email]
        );
      }
      const callResult = await client.query(
        `SELECT call_id FROM team_calls
         WHERE call_id = $1 AND room_key = $2 AND created_at > NOW() - INTERVAL '8 hours'
         FOR UPDATE`,
        [request.params.callId, roomKey]
      );
      if (!callResult.rows.length) {
        await client.query("ROLLBACK");
        response.status(404).json({ error: "This call is no longer available." });
        return;
      }
      await client.query(
        `INSERT INTO team_call_members (call_id, username) VALUES ($1, $2)
         ON CONFLICT (call_id, username) DO UPDATE SET last_seen_at = NOW(), left_at = NULL`,
        [request.params.callId, email]
      );
      const memberResult = await client.query(
        `SELECT username FROM team_call_members
         WHERE call_id = $1 AND left_at IS NULL AND last_seen_at > NOW() - INTERVAL '45 seconds'`,
        [request.params.callId]
      );
      await client.query("DELETE FROM team_calls WHERE created_at < NOW() - INTERVAL '2 days'");
      await client.query("COMMIT");
      response.json({ members: memberResult.rows.map(row => row.username) });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  } catch (error) { next(error); }
});

app.get("/api/calls/:callId/signals", async (request, response, next) => {
  const email = String(request.query.email || "").trim().toLowerCase();
  const cursor = Number(request.query.after || 0);
  if (!validCallIdentity(email, request.params.callId) || !Number.isSafeInteger(cursor) || cursor < 0) {
    response.status(400).json({ error: "A valid account, call ID, and signal cursor are required." });
    return;
  }
  try {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const member = await client.query(
        `UPDATE team_call_members SET last_seen_at = NOW()
         WHERE call_id = $1 AND username = $2 AND left_at IS NULL RETURNING call_id`,
        [request.params.callId, email]
      );
      if (!member.rows.length) {
        await client.query("ROLLBACK");
        response.status(403).json({ error: "Join this call before receiving its signals." });
        return;
      }
      const [signalResult, memberResult] = await Promise.all([
        client.query(
          `SELECT signal_id, sender_username AS sender, signal_type AS type, payload
           FROM team_call_signals
           WHERE call_id = $1 AND signal_id > $2 AND sender_username <> $3
             AND (recipient_username IS NULL OR recipient_username = $3)
           ORDER BY signal_id LIMIT 250`,
          [request.params.callId, cursor, email]
        ),
        client.query(
          `SELECT username FROM team_call_members
           WHERE call_id = $1 AND left_at IS NULL AND last_seen_at > NOW() - INTERVAL '45 seconds'`,
          [request.params.callId]
        )
      ]);
      await client.query("COMMIT");
      response.json({ signals: signalResult.rows, members: memberResult.rows.map(row => row.username) });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  } catch (error) { next(error); }
});

app.post("/api/calls/:callId/signals", async (request, response, next) => {
  const email = String(request.body?.email || "").trim().toLowerCase();
  const { type, recipient, payload = {} } = request.body || {};
  const signalTypes = ["join", "offer", "answer", "ice", "leave"];
  if (!validCallIdentity(email, request.params.callId) || !signalTypes.includes(type) ||
      (recipient !== undefined && (typeof recipient !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient))) ||
      !payload || typeof payload !== "object" || Array.isArray(payload) || Buffer.byteLength(JSON.stringify(payload)) > 65536) {
    response.status(400).json({ error: "The call signal is invalid or too large." });
    return;
  }
  try {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const member = await client.query(
        `UPDATE team_call_members SET last_seen_at = NOW()
         WHERE call_id = $1 AND username = $2 AND left_at IS NULL RETURNING call_id`,
        [request.params.callId, email]
      );
      if (!member.rows.length) {
        await client.query("ROLLBACK");
        response.status(403).json({ error: "Join this call before sending signals." });
        return;
      }
      if (recipient) {
        const target = await client.query(
          `SELECT call_id FROM team_call_members
           WHERE call_id = $1 AND username = $2 AND left_at IS NULL`,
          [request.params.callId, recipient.toLowerCase()]
        );
        if (!target.rows.length) {
          await client.query("ROLLBACK");
          response.status(400).json({ error: "The signal recipient is not in this call." });
          return;
        }
      }
      await client.query(
        `INSERT INTO team_call_signals (call_id, sender_username, recipient_username, signal_type, payload)
         VALUES ($1, $2, $3, $4, $5::jsonb)`,
        [request.params.callId, email, recipient?.toLowerCase() || null, type, JSON.stringify(payload)]
      );
      if (type === "leave") {
        await client.query(
          "UPDATE team_call_members SET left_at = NOW() WHERE call_id = $1 AND username = $2",
          [request.params.callId, email]
        );
      }
      await client.query("COMMIT");
      response.json({ saved: true });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  } catch (error) { next(error); }
});

app.put("/api/presence", async (request, response, next) => {
  const { email, sessionId, isOnline } = request.body || {};
  if (typeof email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
      typeof sessionId !== "string" || !/^[a-zA-Z0-9_-]{8,80}$/.test(sessionId) ||
      (isOnline !== undefined && typeof isOnline !== "boolean")) {
    response.status(400).json({ error: "A valid email, session ID, and optional online status are required." });
    return;
  }
  try {
    await pool.query("DELETE FROM team_chat_presence WHERE last_seen_at < NOW() - INTERVAL '30 days'");
    await pool.query(
      `INSERT INTO team_chat_presence (email, session_id, is_online, last_seen_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (email, session_id) DO UPDATE SET is_online = EXCLUDED.is_online, last_seen_at = NOW()`,
      [email.toLowerCase(), sessionId, isOnline !== false]
    );
    response.json({ saved: true });
  } catch (error) { next(error); }
});

app.get("/api/attachments/:attachmentId", async (request, response, next) => {
  try {
    const { rows } = await pool.query(
      "SELECT file_name, media_type, contents FROM loan_attachments WHERE attachment_id = $1",
      [request.params.attachmentId]
    );
    if (!rows.length) return response.sendStatus(404);
    response.set("Content-Type", attachmentMediaType(rows[0].file_name, rows[0].media_type))
      .set("Content-Disposition", "inline")
      .set("X-Content-Type-Options", "nosniff")
      .send(rows[0].contents);
  } catch (error) { next(error); }
});

app.post("/api/offer-letters/:applicationId/email", async (request, response) => {
  const { attachmentId, requestedBy } = request.body || {};
  if (typeof attachmentId !== "string" || typeof requestedBy !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(requestedBy)) {
    response.status(400).json({ error: "An offer-letter attachment and Admin account are required." });
    return;
  }
  const smtpUser = process.env.SMTP_USER || "";
  const smtpPassword = process.env.SMTP_PASSWORD || "";
  const smtpFrom = process.env.SMTP_FROM || smtpUser;
  if (!process.env.SMTP_HOST || !smtpFrom || Boolean(smtpUser) !== Boolean(smtpPassword)) {
    response.status(503).json({ error: "Offer-letter email is not configured on the server." });
    return;
  }
  try {
    const adminResult = await pool.query(
      "SELECT email FROM system_users WHERE LOWER(email) = LOWER($1) AND role_key = 'admin' LIMIT 1",
      [requestedBy]
    );
    if (!adminResult.rows.length) {
      response.status(403).json({ error: "Only an Admin account can send an offer letter." });
      return;
    }
    const applicationResult = await pool.query(
      "SELECT record FROM loan_applications WHERE application_id = $1",
      [request.params.applicationId]
    );
    if (!applicationResult.rows.length) {
      response.status(404).json({ error: "Loan application not found." });
      return;
    }
    const application = applicationResult.rows[0].record;
    if (application.status !== "Awaiting admin" || application.offerLetter?.attachmentId !== attachmentId || application.offerLetter?.emailStatus === "sent") {
      response.status(409).json({ error: "This offer letter is no longer awaiting email delivery." });
      return;
    }
    const officerResult = await pool.query(
      "SELECT email FROM system_users WHERE full_name = $1 AND role_key = 'officer' ORDER BY email LIMIT 1",
      [application.createdBy]
    );
    if (!officerResult.rows.length) {
      response.status(409).json({ error: "The originating loan officer has no email account in the system." });
      return;
    }
    const attachmentResult = await pool.query(
      "SELECT file_name, media_type, file_size, contents FROM loan_attachments WHERE application_id = $1 AND attachment_id = $2",
      [request.params.applicationId, attachmentId]
    );
    if (!attachmentResult.rows.length || attachmentResult.rows[0].media_type !== "application/pdf" || attachmentResult.rows[0].file_size > 10 * 1024 * 1024) {
      response.status(409).json({ error: "The offer-letter PDF is missing or invalid." });
      return;
    }
    const mailOptions = {
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: String(process.env.SMTP_SECURE || "false").toLowerCase() === "true"
    };
    if (smtpUser && smtpPassword) mailOptions.auth = { user: smtpUser, pass: smtpPassword };
    const transporter = nodemailer.createTransport(mailOptions);
    await transporter.sendMail({
      from: smtpFrom,
      to: officerResult.rows[0].email,
      subject: `Loan offer letter: ${application.id}`,
      text: `The offer letter for ${application.customer} (${application.id}) is attached. It is also available in the loan application in the lending app.`,
      attachments: [{ filename: attachmentResult.rows[0].file_name, content: attachmentResult.rows[0].contents, contentType: "application/pdf" }]
    });
    response.json({ sent: true, recipient: officerResult.rows[0].email });
  } catch (error) {
    console.error("Offer-letter email failed:", error.code || error.message);
    response.status(502).json({ error: "Offer-letter email could not be delivered. Check the server mail settings." });
  }
});

app.put("/api/attachments/:attachmentId", express.raw({ type: "application/octet-stream", limit: "10mb" }), async (request, response, next) => {
  const applicationId = request.get("x-application-id");
  const encodedName = request.get("x-file-name");
  if (!applicationId || !encodedName || !Buffer.isBuffer(request.body)) {
    response.status(400).json({ error: "Attachment metadata and binary content are required" });
    return;
  }
  let fileName;
  try { fileName = decodeURIComponent(encodedName); } catch (error) {
    response.status(400).json({ error: "Invalid attachment filename" });
    return;
  }
  try {
    await pool.query(
      `INSERT INTO loan_attachments (attachment_id, application_id, file_name, category, media_type, file_size, contents)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (attachment_id) DO UPDATE SET application_id = EXCLUDED.application_id,
         file_name = EXCLUDED.file_name, category = EXCLUDED.category, media_type = EXCLUDED.media_type,
         file_size = EXCLUDED.file_size, contents = EXCLUDED.contents, updated_at = NOW()`,
      [request.params.attachmentId, applicationId, fileName, request.get("x-file-category") || "Supporting document", request.get("x-file-media-type") || "application/octet-stream", request.body.length, request.body]
    );
    response.json({ saved: true, attachmentId: request.params.attachmentId });
  } catch (error) { next(error); }
});

app.put("/api/sync", async (request, response, next) => {
  const { applications, customers, messages, users } = request.body || {};
  if (![applications, customers, messages, users].every(Array.isArray)) {
    response.status(400).json({ error: "applications, customers, messages, and users must be arrays" });
    return;
  }

  const client = await pool.connect().catch(next);
  if (!client) return;
  try {
    await client.query("BEGIN");
    for (const user of users) {
      if (!user.email) continue;
      await client.query(
        `INSERT INTO system_users (email, full_name, role, role_key, initials, account)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb)
         ON CONFLICT (email) DO UPDATE SET full_name = EXCLUDED.full_name, role = EXCLUDED.role,
           role_key = EXCLUDED.role_key, initials = EXCLUDED.initials, account = EXCLUDED.account, updated_at = NOW()`,
        [user.email, user.name || "", user.role || "", user.roleKey || "", user.initials || "", JSON.stringify(user)]
      );
    }
    for (const customer of customers) {
      if (!customer.id) continue;
      await client.query(
        `INSERT INTO customers (customer_id, full_name, phone, email, national_id, account_numbers, kyc_status, profile)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8::jsonb)
         ON CONFLICT (customer_id) DO UPDATE SET full_name = EXCLUDED.full_name, phone = EXCLUDED.phone,
           email = EXCLUDED.email, national_id = EXCLUDED.national_id, account_numbers = EXCLUDED.account_numbers, kyc_status = EXCLUDED.kyc_status,
           profile = EXCLUDED.profile, updated_at = NOW()`,
        [customer.id, customer.name || "", customer.phone || "", customer.email || "", customer.nationalId || null, JSON.stringify(customer.accountNumbers || []), customer.kycStatus || "Not started", JSON.stringify(customer)]
      );
      for (const payment of customer.coreBankingPayments || []) {
        const accountId = String(customer.accountNumbers?.[0] || payment.accountId || "");
        if (!accountId) continue;
        const record = JSON.stringify(payment);
        const paymentId = createHash("sha256").update(`${customer.id}\0${accountId}\0${record}`).digest("hex");
        await client.query(
          `INSERT INTO core_repayments (payment_id, customer_id, account_id, received_on, amount, reference, record)
           VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
           ON CONFLICT (payment_id) DO UPDATE SET customer_id = EXCLUDED.customer_id,
             account_id = EXCLUDED.account_id, received_on = EXCLUDED.received_on, amount = EXCLUDED.amount,
             reference = EXCLUDED.reference, record = EXCLUDED.record, updated_at = NOW()`,
          [paymentId, customer.id, accountId, validDate(payment.paymentDate), Number(payment.amount) || 0, String(payment.reference || ""), record]
        );
      }
    }
    for (const loan of applications) {
      if (!loan.id) continue;
      await client.query(
        `INSERT INTO loan_applications (application_id, customer_id, status, amount, submitted_on, record)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb)
         ON CONFLICT (application_id) DO UPDATE SET customer_id = EXCLUDED.customer_id, status = EXCLUDED.status,
           amount = EXCLUDED.amount, submitted_on = EXCLUDED.submitted_on, record = EXCLUDED.record, updated_at = NOW()`,
        [loan.id, loan.customerId || null, loan.status || "Unknown", Number(loan.amount) || 0, validDate(loan.submitted), JSON.stringify(loan)]
      );
      for (const payment of loan.payments || []) {
        if (!payment.id) continue;
        await client.query(
          `INSERT INTO repayments (payment_id, application_id, amount, received_on, record)
           VALUES ($1, $2, $3, $4, $5::jsonb)
           ON CONFLICT (payment_id) DO UPDATE SET application_id = EXCLUDED.application_id,
             amount = EXCLUDED.amount, received_on = EXCLUDED.received_on, record = EXCLUDED.record`,
          [payment.id, loan.id, Number(payment.amount) || 0, validDate(payment.receivedDate), JSON.stringify(payment)]
        );
      }
    }
    for (const message of messages) {
      const sender = String(message.username || "").trim().toLowerCase();
      const recipient = message.recipient ? String(message.recipient).trim().toLowerCase() : null;
      if (!message.id || !sender || (recipient && (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient) || recipient === sender))) continue;
      await client.query(
        `INSERT INTO team_messages (message_id, sender_username, recipient_username, record)
         VALUES ($1, $2, $3, $4::jsonb)
         ON CONFLICT (message_id) DO UPDATE SET sender_username = EXCLUDED.sender_username,
           recipient_username = EXCLUDED.recipient_username,
           record = jsonb_set(EXCLUDED.record, '{readBy}', (
             SELECT COALESCE(jsonb_agg(DISTINCT receipts.read_by), '[]'::jsonb)
             FROM jsonb_array_elements_text(
               COALESCE(team_messages.record->'readBy', '[]'::jsonb) || COALESCE(EXCLUDED.record->'readBy', '[]'::jsonb)
             ) AS receipts(read_by)
           ))`,
        [message.id, sender, recipient, JSON.stringify({ ...message, username: sender, recipient })]
      );
    }
    await client.query("COMMIT");
    response.json({ saved: true, applications: applications.length, customers: customers.length, messages: messages.length, users: users.length });
  } catch (error) {
    await client.query("ROLLBACK");
    next(error);
  } finally {
    client.release();
  }
});

app.use((error, request, response, next) => {
  console.error("Database API request failed:", error.message);
  if (response.headersSent) return next(error);
  response.status(500).json({ error: "The database request could not be completed." });
});

async function start() {
  try {
    await initializeSchema();
    const port = Number(process.env.PORT || 3000);
    app.listen(port, "127.0.0.1", () => console.log(`Maisha Microfinance Bank is running at http://127.0.0.1:${port}`));
  } catch (error) {
    console.error("Could not initialize PostgreSQL schema:", error.message);
    await pool.end();
    process.exit(1);
  }
}

start();