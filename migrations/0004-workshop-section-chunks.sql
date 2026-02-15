CREATE TABLE IF NOT EXISTS indexed_section_chunks (
	id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
	workshop_slug TEXT NOT NULL,
	exercise_number INTEGER,
	step_number INTEGER,
	section_order INTEGER NOT NULL,
	chunk_index INTEGER NOT NULL,
	content TEXT NOT NULL,
	char_count INTEGER NOT NULL,
	vector_id TEXT,
	index_run_id TEXT NOT NULL,
	FOREIGN KEY (workshop_slug) REFERENCES indexed_workshops(workshop_slug) ON DELETE CASCADE,
	FOREIGN KEY (index_run_id) REFERENCES workshop_index_runs(id),
	UNIQUE (workshop_slug, exercise_number, step_number, section_order, chunk_index, index_run_id)
);

CREATE INDEX IF NOT EXISTS idx_indexed_section_chunks_scope
	ON indexed_section_chunks(workshop_slug, exercise_number, step_number, section_order, chunk_index);

CREATE INDEX IF NOT EXISTS idx_indexed_section_chunks_vector_id
	ON indexed_section_chunks(vector_id);
