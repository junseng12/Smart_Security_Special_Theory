'use strict';

require('dotenv').config();

const { connectDB } = require('../src/services/db');

async function main() {
  const pool = await connectDB();
  try {
    const { rows } = await pool.query(`
      SELECT tablename
      FROM pg_tables
      WHERE schemaname = current_schema()
      ORDER BY tablename
    `);

    console.log('Database migration complete. Tables:');
    for (const row of rows) console.log(`- ${row.tablename}`);
  } finally {
    await pool.end();
  }
}

main().catch(err => {
  console.error('Database migration failed:', err.message);
  process.exit(1);
});
