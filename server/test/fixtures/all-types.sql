-- Throwaway fixture for checking the live data viewer against every common Postgres column type.
-- Load into a scratch database only:
--   docker run -d --name goforge-fixture -e POSTGRES_PASSWORD=fixture -p 54329:5432 postgres:16
--   docker exec -i goforge-fixture psql -U postgres -v ON_ERROR_STOP=1 < server/test/fixtures/all-types.sql

CREATE EXTENSION IF NOT EXISTS hstore;

CREATE TYPE mood AS ENUM ('sad', 'ok', 'happy');
CREATE TYPE address AS (street text, zip text);
CREATE DOMAIN positive_int AS integer CHECK (VALUE > 0);

CREATE TABLE all_types (
    id            serial PRIMARY KEY,
    c_smallint    smallint,
    c_int         integer,
    c_bigint      bigint,
    c_numeric     numeric(30, 10),
    c_real        real,
    c_double      double precision,
    c_money       money,
    c_bool        boolean,
    c_text        text,
    c_varchar     varchar(20),
    c_char        char(5),
    c_uuid        uuid,
    c_json        json,
    c_jsonb       jsonb,
    c_int_array   integer[],
    c_text_matrix text[][],
    c_bytea       bytea,
    c_date        date,
    c_time        time,
    c_timetz      timetz,
    c_timestamp   timestamp,
    c_timestamptz timestamptz,
    c_interval    interval,
    c_inet        inet,
    c_cidr        cidr,
    c_macaddr     macaddr,
    c_int4range   int4range,
    c_tstzrange   tstzrange,
    c_point       point,
    c_polygon     polygon,
    c_bit         bit(8),
    c_varbit      varbit(16),
    c_tsvector    tsvector,
    c_xml         xml,
    c_hstore      hstore,
    c_mood        mood,
    c_address     address,
    c_domain      positive_int,
    c_generated   integer GENERATED ALWAYS AS (c_int * 2) STORED
);

-- 1: a value of every type
INSERT INTO all_types (
    c_smallint, c_int, c_bigint, c_numeric, c_real, c_double, c_money, c_bool, c_text, c_varchar, c_char, c_uuid,
    c_json, c_jsonb, c_int_array, c_text_matrix, c_bytea, c_date, c_time, c_timetz, c_timestamp, c_timestamptz,
    c_interval, c_inet, c_cidr, c_macaddr, c_int4range, c_tstzrange, c_point, c_polygon, c_bit, c_varbit,
    c_tsvector, c_xml, c_hstore, c_mood, c_address, c_domain
) VALUES (
    32767, 100, 9223372036854775807, 12345678901234567890.1234567890, 3.14, 2.718281828459045, 12345.67, true,
    'héllo wörld 日本語 😀', 'varchar value', 'abc', 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
    '{"a": 1, "b": [1, 2, 3], "nested": {"k": "v"}}',
    '{"a": 1, "b": [1, 2, 3], "nested": {"k": "é"}, "nul": null}',
    ARRAY[1, 2, NULL, 4], ARRAY[['a', 'b'], ['c', 'd']], '\xdeadbeef',
    '2024-02-29', '13:45:30.123456', '13:45:30+05:30', '2024-02-29 13:45:30.123456', '2024-02-29 13:45:30.123456+05:30',
    '1 year 2 mons 3 days 04:05:06', '192.168.0.1/24', '10.1.0.0/16', '08:00:2b:01:02:03',
    '[1,10)', '[2024-01-01 00:00+00,2024-12-31 00:00+00)', '(1.5,2.5)', '((0,0),(4,0),(4,3))', B'10101010', B'1011',
    to_tsvector('english', 'The quick brown fox'), '<a><b>1</b></a>', '"k"=>"v", "x"=>NULL', 'happy',
    ROW('1 Main St', '90210'), 5
);

-- 2: every column NULL
INSERT INTO all_types (c_int) VALUES (NULL);

-- 3: oversized values (truncation) and infinity
INSERT INTO all_types (c_int, c_text, c_jsonb, c_bytea, c_bigint, c_date, c_timestamp, c_timestamptz)
VALUES (7, repeat('x', 10000), jsonb_build_object('k', repeat('y', 6000)), decode(repeat('ab', 3000), 'hex'),
        -9223372036854775808, '-infinity', 'infinity', 'infinity');

-- 4: the string 'NULL' and empty string must not look like SQL NULL
INSERT INTO all_types (c_int, c_text, c_varchar, c_bool, c_jsonb, c_bytea) VALUES (2, 'NULL', '', false, '{}', '\x');

-- 5: multi-line text
INSERT INTO all_types (c_int, c_text) VALUES (9, E'line one\nline two');

-- 6: sorts after 9 numerically but before 2 as text
INSERT INTO all_types (c_int, c_text) VALUES (10, 'ten');

CREATE VIEW all_types_view AS SELECT id, c_text, c_jsonb FROM all_types;
CREATE MATERIALIZED VIEW all_types_mv AS SELECT id, c_int FROM all_types;
ANALYZE all_types;

-- No primary key: paging falls back to ctid
CREATE TABLE no_pk (a integer, b text);
INSERT INTO no_pk SELECT i % 3, 'row ' || i FROM generate_series(1, 25) AS i;

-- Identifiers that need quoting
CREATE TABLE "Weird ""Table" ("Col ""A""" integer PRIMARY KEY, "select" text);
INSERT INTO "Weird ""Table" VALUES (1, 'one'), (2, 'two');

-- A schema other than public
CREATE SCHEMA analytics;
CREATE TABLE analytics.events (id bigserial PRIMARY KEY, payload jsonb);
INSERT INTO analytics.events (payload) SELECT jsonb_build_object('n', i) FROM generate_series(1, 5) AS i;

-- A view that outlives the 15s statement timeout
CREATE VIEW slow_view AS SELECT pg_sleep(20)::text AS s;

-- Enough rows to exercise paging, page size and the exact/estimated count
CREATE TABLE big_table AS SELECT i AS id, md5(i::text) AS hash FROM generate_series(1, 1200) AS i;
ALTER TABLE big_table ADD PRIMARY KEY (id);
ANALYZE big_table;
