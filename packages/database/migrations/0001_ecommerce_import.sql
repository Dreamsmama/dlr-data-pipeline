CREATE TABLE IF NOT EXISTS ecommerce_import_batches (
  batch_id UUID PRIMARY KEY,
  platform TEXT NOT NULL,
  source_datasets TEXT[] NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
  counts JSONB NOT NULL DEFAULT '{}'::jsonb,
  error TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS ecommerce_products (
  platform TEXT NOT NULL,
  item_id TEXT NOT NULL,
  source_url TEXT NOT NULL,
  title TEXT NOT NULL,
  latest_collected_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (platform, item_id)
);

CREATE TABLE IF NOT EXISTS ecommerce_product_observations (
  observation_id CHAR(64) PRIMARY KEY CHECK (observation_id ~ '^[0-9a-f]{64}$'),
  platform TEXT NOT NULL,
  item_id TEXT NOT NULL,
  source_dataset TEXT NOT NULL,
  collected_at TIMESTAMPTZ NOT NULL,
  payload JSONB NOT NULL,
  raw_product_object_key TEXT,
  raw_json_object_key TEXT,
  raw_html_object_key TEXT,
  first_imported_batch_id UUID NOT NULL REFERENCES ecommerce_import_batches(batch_id),
  last_imported_batch_id UUID NOT NULL REFERENCES ecommerce_import_batches(batch_id),
  UNIQUE (source_dataset, item_id, collected_at),
  FOREIGN KEY (platform, item_id) REFERENCES ecommerce_products(platform, item_id)
);

CREATE TABLE IF NOT EXISTS ecommerce_assets (
  sha256 CHAR(64) PRIMARY KEY CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  object_key TEXT NOT NULL UNIQUE,
  byte_size BIGINT NOT NULL CHECK (byte_size > 0),
  content_type TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ecommerce_product_assets (
  platform TEXT NOT NULL,
  item_id TEXT NOT NULL,
  asset_sha256 CHAR(64) NOT NULL REFERENCES ecommerce_assets(sha256),
  source_datasets TEXT[] NOT NULL,
  image_types TEXT[] NOT NULL,
  source_urls JSONB NOT NULL,
  first_collected_at TIMESTAMPTZ NOT NULL,
  last_collected_at TIMESTAMPTZ NOT NULL,
  needs_review BOOLEAN NOT NULL,
  last_imported_batch_id UUID NOT NULL REFERENCES ecommerce_import_batches(batch_id),
  PRIMARY KEY (platform, item_id, asset_sha256),
  FOREIGN KEY (platform, item_id) REFERENCES ecommerce_products(platform, item_id)
);

CREATE TABLE IF NOT EXISTS ecommerce_image_observations (
  observation_id CHAR(64) NOT NULL REFERENCES ecommerce_product_observations(observation_id),
  position INTEGER NOT NULL CHECK (position >= 0),
  asset_sha256 CHAR(64) NOT NULL REFERENCES ecommerce_assets(sha256),
  source_url TEXT NOT NULL,
  image_type TEXT NOT NULL,
  local_path TEXT NOT NULL,
  needs_review BOOLEAN NOT NULL,
  alt TEXT NOT NULL,
  width INTEGER,
  height INTEGER,
  status TEXT NOT NULL,
  PRIMARY KEY (observation_id, position)
);

CREATE TABLE IF NOT EXISTS ecommerce_raw_objects (
  source_dataset TEXT NOT NULL,
  item_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('product_json', 'raw_json', 'raw_html', 'snapshot')),
  relative_path TEXT NOT NULL,
  sha256 CHAR(64) NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  object_key TEXT NOT NULL,
  byte_size BIGINT NOT NULL CHECK (byte_size > 0),
  content_type TEXT NOT NULL,
  first_imported_batch_id UUID NOT NULL REFERENCES ecommerce_import_batches(batch_id),
  last_imported_batch_id UUID NOT NULL REFERENCES ecommerce_import_batches(batch_id),
  PRIMARY KEY (source_dataset, relative_path, sha256)
);

CREATE INDEX IF NOT EXISTS idx_ecommerce_observations_product
  ON ecommerce_product_observations(platform, item_id, collected_at DESC);
CREATE INDEX IF NOT EXISTS idx_ecommerce_product_assets_sha
  ON ecommerce_product_assets(asset_sha256);
CREATE INDEX IF NOT EXISTS idx_ecommerce_image_observations_sha
  ON ecommerce_image_observations(asset_sha256);
