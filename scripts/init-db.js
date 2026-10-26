require("dotenv").config();

const fs = require("node:fs");
const path = require("node:path");
const { Client } = require("pg");

const missingSettings = ["DB_HOST", "DB_NAME", "DB_USER", "DB_PASSWORD"].filter(name => !process.env[name]);
if (missingSettings.length) {
  console.error(`Missing database settings: ${missingSettings.join(", ")}. Set them in the environment or local .env file.`);
  process.exit(1);
}

async function initializeDatabase() {
  const client = new Client({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 5432),
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 5000
  });
  try {
    await client.connect();
    await client.query(fs.readFileSync(path.join(__dirname, "..", "schema.sql"), "utf8"));
    const { rows } = await client.query("SELECT current_database() AS database");
    console.log(`Lending schema initialized in database ${rows[0].database}.`);
  } finally {
    await client.end();
  }
}

initializeDatabase().catch(error => {
  console.error("Database initialization failed:", error.message);
  process.exitCode = 1;
});