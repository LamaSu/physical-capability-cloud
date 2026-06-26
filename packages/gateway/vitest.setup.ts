/**
 * Vitest global setup.
 *
 * Sets in-memory SQLite paths BEFORE any test file's imports execute. This is
 * required because some gateway modules (e.g. activities/escrow.ts) eagerly
 * open SQLite stores via @pcc/workflow at module-load time — once an import
 * graph reaches them, it is too late for an individual test to set
 * WORKFLOW_DB_PATH itself (ES-module imports are hoisted above top-level
 * statements). vitest invokes setupFiles before any test module is parsed.
 *
 * Tests that need a real DB path can override these in their own beforeAll.
 */

process.env.PCC_DB_PATH = process.env.PCC_DB_PATH ?? ":memory:";
process.env.WORKFLOW_DB_PATH = process.env.WORKFLOW_DB_PATH ?? ":memory:";
