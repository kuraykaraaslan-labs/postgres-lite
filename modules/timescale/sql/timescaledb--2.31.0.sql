-- postgres-lite TimescaleDB-compatible subset, install script.
-- Written from TimescaleDB's public documentation only; no Timescale source is used.
\echo Use "CREATE EXTENSION timescaledb" to load this file. \quit

CREATE SCHEMA _timescaledb_catalog;
CREATE SCHEMA _timescaledb_config;
CREATE SCHEMA _timescaledb_internal;
CREATE SCHEMA timescaledb_information;
GRANT USAGE ON SCHEMA _timescaledb_catalog, _timescaledb_config, _timescaledb_internal, timescaledb_information TO PUBLIC;

-- Relations are kept by schema and name, never by OID, so a dump and restore into a new cluster stays valid.
CREATE TABLE _timescaledb_catalog.hypertable (
  id serial PRIMARY KEY,
  schema_name name NOT NULL,
  table_name name NOT NULL,
  num_dimensions smallint NOT NULL DEFAULT 1,
  compression_enabled boolean NOT NULL DEFAULT false,
  UNIQUE (schema_name, table_name)
);
GRANT SELECT ON _timescaledb_catalog.hypertable TO PUBLIC;

-- Without these, pg_dump treats extension-owned rows as part of the extension and drops every hypertable.
SELECT pg_catalog.pg_extension_config_dump('_timescaledb_catalog.hypertable', '');
SELECT pg_catalog.pg_extension_config_dump('_timescaledb_catalog.hypertable_id_seq', '');

-- Timescale aligns timestamptz buckets in UTC from Monday 2000-01-03 by default.
-- date_bin cannot bin months; month buckets come with the full overload set in Phase F.
CREATE FUNCTION @extschema@.time_bucket(bucket_width interval, ts timestamptz)
RETURNS timestamptz
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
RETURN pg_catalog.date_bin(bucket_width, ts, timestamptz '2000-01-03 00:00:00+00');

CREATE VIEW timescaledb_information.hypertables AS
SELECT h.schema_name AS hypertable_schema,
       h.table_name AS hypertable_name,
       pg_catalog.pg_get_userbyid(c.relowner) AS owner,
       h.num_dimensions,
       0::bigint AS num_chunks,
       h.compression_enabled,
       NULL::name[] AS tablespaces
  FROM _timescaledb_catalog.hypertable h
  LEFT JOIN pg_catalog.pg_namespace n ON n.nspname = h.schema_name
  LEFT JOIN pg_catalog.pg_class c ON c.relnamespace = n.oid AND c.relname = h.table_name;
GRANT SELECT ON timescaledb_information.hypertables TO PUBLIC;
