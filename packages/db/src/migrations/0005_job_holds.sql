-- Emergency-stop interlock. Mirrors runtime DDL in migrate.ts.
CREATE TABLE IF NOT EXISTS job_holds (
  job_id TEXT PRIMARY KEY REFERENCES jobs(id),
  kernel_id TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason = 'emergency_stop'),
  held_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS job_holds_kernel_idx ON job_holds(kernel_id);
