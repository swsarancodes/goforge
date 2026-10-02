# Milestone 2: Advanced schema engineering

Milestone 2 turns GoForge from a table diagrammer into a versioned schema engineering workspace. Work is ordered by data-model dependency so import/export, migration history, linting, AI planning, and live drift all share the same canonical representation.

## Phase 1 — Constraint foundation

- Preserve and render composite primary keys.
- Add grouped composite foreign keys with ordered source/target columns.
- Add first-class check constraints.
- Preserve multi-column unique constraints and their names.
- Keep existing single-column flags and relationships backward compatible while projects migrate to grouped constraints.

Acceptance criteria:

- SQL import and export round-trip composite keys and named constraints without splitting their semantics.
- Constraint changes appear in the visual diff and generated migrations.
- Invalid or incomplete column groups are rejected before persistence.

## Phase 2 — Namespaces and advanced objects

- Database schemas/namespaces and qualified identifiers.
- Views and materialized views with stored definitions and dependency metadata.
- Sequences, generated columns, domains, and native enums.
- Table and column documentation rendered to dialect-appropriate DDL.

Acceptance criteria:

- Objects retain namespace and stable IDs through import, editing, export, and live introspection.
- Dialect capability checks prevent unsupported DDL from being generated silently.

## Phase 3 — Portable project formats

- Versioned Project JSON import/export with validation and forward-compatible migrations.
- DBML import/export mapped through the canonical schema model.
- Import review shows warnings and a visual diff before replacing or merging a project.

Acceptance criteria:

- A project survives JSON and DBML round trips without losing supported metadata.
- Unsupported source features produce explicit warnings rather than disappearing.

## Phase 4 — Change management

- Immutable schema snapshots.
- Local migration history linked to source and target snapshot IDs.
- Deterministic up/down SQL generation.
- Restore and compare workflows using the existing one-step undo transaction boundary.

Acceptance criteria:

- Every accepted migration records before/after snapshots and reproducible SQL.
- Down migrations are blocked when a safe inverse cannot be generated.

## Phase 5 — Quality and live database control

- Schema linting with configurable naming conventions and severity.
- Drift detection between the canvas and a freshly introspected live database.
- Object-level drift classification with pull, ignore, and push workflows.

Acceptance criteria:

- Lint results identify stable object IDs and can be filtered by severity.
- Drift checks never mutate either side until the user reviews and confirms a plan.

## Delivery order

1. Composite primary keys and multi-column unique round trips.
2. Canonical grouped constraints: composite foreign keys and checks.
3. Namespaces and advanced object types.
4. Versioned Project JSON, then DBML.
5. Snapshots and up/down migrations.
6. Linting and naming conventions.
7. Live drift detection and reconciliation.

