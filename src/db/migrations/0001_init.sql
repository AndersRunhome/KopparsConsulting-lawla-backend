-- Lawla backend – grundschema. Se docs/ARCHITECTURE.md §4.
CREATE EXTENSION IF NOT EXISTS vector;

-- ─── Användare ──────────────────────────────────────────────────────────
CREATE TABLE users (
  id            BIGSERIAL PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  name          TEXT,
  password_hash TEXT,
  google_sub    TEXT UNIQUE,
  role          TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member','admin')),
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at TIMESTAMPTZ
);

-- ─── Ärendelagret ───────────────────────────────────────────────────────
CREATE TABLE projects (
  id            BIGSERIAL PRIMARY KEY,
  owner_id      BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title         TEXT,
  description   TEXT,
  case_overview TEXT,
  main_prompt   TEXT,
  status        SMALLINT NOT NULL DEFAULT 0,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX projects_owner_idx ON projects(owner_id);

-- Frågor, omständigheter och rättsfrågor har samma form; kind skiljer dem åt.
CREATE TABLE project_items (
  id          BIGSERIAL PRIMARY KEY,
  project_id  BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('question','circumstance','legal_issue')),
  text        TEXT NOT NULL,
  sort_order  INT NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX project_items_project_idx ON project_items(project_id, kind, sort_order);

-- ─── Korpuslagret ───────────────────────────────────────────────────────
CREATE TABLE documents (
  id            BIGSERIAL PRIMARY KEY,
  title         TEXT NOT NULL,
  source        TEXT NOT NULL,                 -- lagen.nu | riksdagen | domstol | upload
  source_url    TEXT,
  source_type   TEXT,                          -- lagen.nu:s "sfs" / "dv" / "forarbete" …
  document_type TEXT NOT NULL,                 -- lag | forordning | proposition | sou | ds | betankande | rattsfall | doktrin | ovrigt
  canonical_id  TEXT UNIQUE,                   -- sfs:2005:716 | prop:2005/06:77 | nja:2015:899
  identifier    TEXT,                          -- "SFS 2005:716", "Prop. 2005/06:77"
  status        TEXT NOT NULL DEFAULT 'gallande' CHECK (status IN ('gallande','upphavd','okand')),
  version_date  DATE,
  raw_key       TEXT,                          -- nyckel i objektlagret
  tags          TEXT[] NOT NULL DEFAULT '{}',
  metadata      JSONB NOT NULL DEFAULT '{}',
  content_hash  TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX documents_type_idx ON documents(document_type);

CREATE TABLE chunks (
  id           BIGSERIAL PRIMARY KEY,
  document_id  BIGINT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  chunk_index  INT NOT NULL,
  anchor       TEXT NOT NULL,                  -- K5P16c, P36, A3-2 …
  kind         TEXT NOT NULL,                  -- paragraf | avsnitt | kommentar | domskal | rubrik | text
  label        TEXT,                           -- "5 kap. 16 c §"
  path         TEXT[] NOT NULL DEFAULT '{}',   -- ["5 kap. Uppehållstillstånd", "16 c §"]
  parent_id    BIGINT REFERENCES chunks(id) ON DELETE SET NULL,
  context      TEXT NOT NULL DEFAULT '',       -- sökväg i klartext, prefix vid embedding
  content      TEXT NOT NULL,
  summary      TEXT,                           -- LLM-berikning, vardagsspråk
  keywords     TEXT[] NOT NULL DEFAULT '{}',
  metadata     JSONB NOT NULL DEFAULT '{}',
  tsv          TSVECTOR,                    -- sätts av trigger chunks_tsv (svensk konfiguration)
  embedding    vector(1024),
  UNIQUE (document_id, anchor)
);
CREATE INDEX chunks_document_idx ON chunks(document_id, chunk_index);
CREATE INDEX chunks_tsv_idx ON chunks USING GIN(tsv);
CREATE INDEX chunks_label_idx ON chunks(label);
CREATE INDEX chunks_embedding_idx ON chunks USING hnsw (embedding vector_cosine_ops);

-- Fulltextvektorn vägs: etikett (A), sökväg/sammanfattning/nyckelord (B), text (C).
CREATE FUNCTION chunks_tsv_update() RETURNS trigger AS $$
BEGIN
  NEW.tsv :=
    setweight(to_tsvector('swedish'::regconfig, coalesce(NEW.label, '')), 'A') ||
    setweight(to_tsvector('swedish'::regconfig, coalesce(NEW.context, '')), 'B') ||
    setweight(to_tsvector('swedish'::regconfig, NEW.content), 'C') ||
    setweight(to_tsvector('swedish'::regconfig, coalesce(NEW.summary, '') || ' ' || array_to_string(NEW.keywords, ' ')), 'B');
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER chunks_tsv BEFORE INSERT OR UPDATE OF label, context, content, summary, keywords ON chunks
  FOR EACH ROW EXECUTE FUNCTION chunks_tsv_update();

-- Hänvisningar ur korpusens egna texter (bygger relationsgrafen).
CREATE TABLE document_references (
  id                  BIGSERIAL PRIMARY KEY,
  source_document_id  BIGINT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  source_chunk_id     BIGINT REFERENCES chunks(id) ON DELETE CASCADE,
  citation_text       TEXT NOT NULL,
  canonical_form      TEXT NOT NULL,           -- sfs:2005:716#K5P16c | nja:2015:899 | prop:2005/06:77
  reference_type      TEXT NOT NULL,           -- lagrum | rattsfall | forarbete
  target_document_id  BIGINT REFERENCES documents(id) ON DELETE SET NULL,
  target_chunk_id     BIGINT REFERENCES chunks(id) ON DELETE SET NULL,
  is_resolved         BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE INDEX document_references_source_idx ON document_references(source_document_id);
CREATE INDEX document_references_target_idx ON document_references(target_document_id);
CREATE INDEX document_references_canonical_idx ON document_references(canonical_form);

-- Omnumreringar och ändringsförfattningar per lagrum.
CREATE TABLE provision_history (
  id              BIGSERIAL PRIMARY KEY,
  document_id     BIGINT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  anchor          TEXT NOT NULL,
  change_sfs      TEXT NOT NULL,
  prop            TEXT,
  old_label       TEXT,
  new_label       TEXT,
  effective_date  DATE,
  note            TEXT
);
CREATE INDEX provision_history_idx ON provision_history(document_id, anchor);

-- ─── Underlag, analyser, versioner ──────────────────────────────────────
CREATE TABLE project_evidence (
  id                  BIGSERIAL PRIMARY KEY,
  project_id          BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  type                SMALLINT NOT NULL DEFAULT 0,
  document_id         BIGINT REFERENCES documents(id) ON DELETE SET NULL,
  chunk_id            BIGINT REFERENCES chunks(id) ON DELETE SET NULL,
  content             TEXT,
  display_label       TEXT,
  annotation          TEXT,
  canonical_reference TEXT,
  external_url        TEXT,
  char_start          INT,
  char_end            INT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX project_evidence_project_idx ON project_evidence(project_id);

CREATE TABLE analyses (
  id             BIGSERIAL PRIMARY KEY,
  project_id     BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  legal_issue_id BIGINT REFERENCES project_items(id) ON DELETE CASCADE,  -- NULL = samlad analys
  output_content TEXT NOT NULL DEFAULT '',
  citations      JSONB NOT NULL DEFAULT '[]',
  input_summary  JSONB NOT NULL DEFAULT '{}',
  model          TEXT,
  status         TEXT NOT NULL DEFAULT 'done' CHECK (status IN ('running','done','error')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX analyses_project_idx ON analyses(project_id, legal_issue_id, created_at);

CREATE TABLE project_versions (
  id          BIGSERIAL PRIMARY KEY,
  project_id  BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  label       TEXT,
  trigger     TEXT NOT NULL,
  hash        TEXT NOT NULL,
  snapshot    JSONB NOT NULL,
  created_by  BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX project_versions_idx ON project_versions(project_id, created_at);

CREATE TABLE report_shares (
  token       TEXT PRIMARY KEY,
  project_id  BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  label       TEXT,
  payload     JSONB NOT NULL,
  shared_by   TEXT,
  expires_at  TIMESTAMPTZ,
  revoked_at  TIMESTAMPTZ,
  view_count  INT NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX report_shares_project_idx ON report_shares(project_id);

CREATE TABLE source_notes (
  project_id  BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source_key  TEXT NOT NULL,
  text        TEXT NOT NULL DEFAULT '',
  updated_by  TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, source_key)
);

CREATE TABLE feedback (
  id          BIGSERIAL PRIMARY KEY,
  user_id     BIGINT REFERENCES users(id) ON DELETE SET NULL,
  description TEXT NOT NULL,
  path        TEXT,
  priority    TEXT NOT NULL DEFAULT 'normal',
  user_agent  TEXT,
  viewport    TEXT,
  status      TEXT NOT NULL DEFAULT 'open',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── Ingest-jobb ────────────────────────────────────────────────────────
CREATE TABLE ingest_jobs (
  id          BIGSERIAL PRIMARY KEY,
  source      TEXT NOT NULL,
  uri         TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','error')),
  document_id BIGINT REFERENCES documents(id) ON DELETE SET NULL,
  error       TEXT,
  attempts    INT NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ingest_jobs_status_idx ON ingest_jobs(status, created_at);
