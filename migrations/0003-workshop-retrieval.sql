CREATE TABLE IF NOT EXISTS workshop_index_runs (
	id TEXT PRIMARY KEY NOT NULL,
	status TEXT NOT NULL,
	started_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
	completed_at TEXT,
	error_message TEXT,
	workshop_count INTEGER NOT NULL DEFAULT 0,
	exercise_count INTEGER NOT NULL DEFAULT 0,
	step_count INTEGER NOT NULL DEFAULT 0,
	section_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS indexed_workshops (
	workshop_slug TEXT PRIMARY KEY NOT NULL,
	title TEXT NOT NULL,
	product TEXT,
	repo_owner TEXT NOT NULL,
	repo_name TEXT NOT NULL,
	default_branch TEXT NOT NULL,
	source_sha TEXT NOT NULL,
	exercise_count INTEGER NOT NULL DEFAULT 0,
	has_diffs INTEGER NOT NULL DEFAULT 0,
	last_indexed_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
	index_run_id TEXT NOT NULL,
	FOREIGN KEY (index_run_id) REFERENCES workshop_index_runs(id)
);

CREATE TABLE IF NOT EXISTS indexed_exercises (
	id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
	workshop_slug TEXT NOT NULL,
	exercise_number INTEGER NOT NULL,
	title TEXT NOT NULL,
	step_count INTEGER NOT NULL DEFAULT 0,
	FOREIGN KEY (workshop_slug) REFERENCES indexed_workshops(workshop_slug) ON DELETE CASCADE,
	UNIQUE (workshop_slug, exercise_number)
);

CREATE TABLE IF NOT EXISTS indexed_steps (
	id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
	workshop_slug TEXT NOT NULL,
	exercise_number INTEGER NOT NULL,
	step_number INTEGER NOT NULL,
	problem_dir TEXT,
	solution_dir TEXT,
	has_diff INTEGER NOT NULL DEFAULT 0,
	FOREIGN KEY (workshop_slug) REFERENCES indexed_workshops(workshop_slug) ON DELETE CASCADE,
	UNIQUE (workshop_slug, exercise_number, step_number)
);

CREATE TABLE IF NOT EXISTS indexed_sections (
	id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
	workshop_slug TEXT NOT NULL,
	exercise_number INTEGER,
	step_number INTEGER,
	section_order INTEGER NOT NULL,
	section_kind TEXT NOT NULL,
	label TEXT NOT NULL,
	source_path TEXT,
	content TEXT NOT NULL,
	char_count INTEGER NOT NULL,
	is_diff INTEGER NOT NULL DEFAULT 0,
	index_run_id TEXT NOT NULL,
	FOREIGN KEY (workshop_slug) REFERENCES indexed_workshops(workshop_slug) ON DELETE CASCADE,
	FOREIGN KEY (index_run_id) REFERENCES workshop_index_runs(id)
);

CREATE INDEX IF NOT EXISTS idx_index_runs_status
	ON workshop_index_runs(status);

CREATE INDEX IF NOT EXISTS idx_indexed_workshops_product
	ON indexed_workshops(product);

CREATE INDEX IF NOT EXISTS idx_indexed_workshops_last_indexed_at
	ON indexed_workshops(last_indexed_at);

CREATE INDEX IF NOT EXISTS idx_indexed_exercises_scope
	ON indexed_exercises(workshop_slug, exercise_number);

CREATE INDEX IF NOT EXISTS idx_indexed_steps_scope
	ON indexed_steps(workshop_slug, exercise_number, step_number);

CREATE INDEX IF NOT EXISTS idx_indexed_sections_scope_order
	ON indexed_sections(workshop_slug, exercise_number, step_number, section_order, id);

CREATE INDEX IF NOT EXISTS idx_indexed_sections_diff_scope
	ON indexed_sections(workshop_slug, exercise_number, step_number, is_diff, section_order, id);
