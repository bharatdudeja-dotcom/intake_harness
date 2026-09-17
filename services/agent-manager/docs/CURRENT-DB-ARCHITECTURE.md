# Current DB / Persistence Architecture

This document captures the architecture that actually exists in this repo today, as implemented in code and in the local Docker setup. It is the state to hand to Chauncey and Claude before any move to Postgres.

## Executive summary

This project does not currently use a Postgres database.

The live architecture is document/blob storage built around a storage abstraction with drivers for:

- local filesystem (`fs`)
- S3 / MinIO / R2 (`s3`)
- Google Cloud Storage (`gcs`)
- Adobe I/O Files (`aio`)

The app stores records as JSON files in a mounted data root, not in a relational database. This is a deliberate design choice recorded in the project decisions.

## Evidence in code

### 1) Storage abstraction is the real infrastructure boundary

See: `app/lib/storage/index.js`

The app resolves a driver from `STORAGE_DRIVER`, defaulting to `fs`:

- `STORAGE_DRIVER=fs` -> local disk
- `STORAGE_DRIVER=s3` -> S3 / MinIO / R2
- `STORAGE_DRIVER=gcs` -> Google Cloud Storage
- `STORAGE_DRIVER=aio` -> Adobe I/O Files

This abstraction is the true persistence layer. `lib/store.js` calls the storage API instead of talking to a database directly.

### 2) Local deployment is a mounted Docker volume, not a Postgres container

See: `docker-compose.yml`

The service sets:

- `STORAGE_DRIVER: "fs"`
- `STORAGE_ROOT: "/data"`
- mounted volume: `agent-manager-data:/data`

That means the app writes to a filesystem-backed data directory in the container. There is no Postgres service, no `postgres` container, and no `pgdata` volume.

### 3) Records are persisted as JSON resources, not relational rows

See: `app/lib/store.js`

The save path is conceptually:

- `resources/<id>.json` for the full resource document
- `resources/index.json` for the catalog metadata
- additional JSON files such as:
  - `resources/projects.json`
  - `resources/settings.json`
  - `resources/cx-graph.json`
  - `resources/users.json`

The resource write is done with a generic storage interface, and the "catalog" is just a JSON array of metadata entries.

### 4) The design explicitly says “no Postgres”

See: `docs/DECISIONS.md`

The repo records the decision:

- “No Postgres. CX Agent Manager keeps the cookbook engine's store.”

This is not an incidental implementation leftover. It is a deliberate architecture decision.

## Current runtime shape

The current runtime is effectively:

- App code in `app/`
- Storage backend selected by environment
- Data files persisted under a mounted root (default `/data`)
- No SQL schema, no DB migrations, no Postgres connection string

### Default local shape

```yaml
services:
  agent-manager:
    environment:
      STORAGE_DRIVER: "fs"
      STORAGE_ROOT: "/data"
    volumes:
      - agent-manager-data:/data
```

This is the default and is the setup that matches the repo as it stands.

## Data model today

The app stores a run-like document model, not a relational model. It is closer to:

- per-resource JSON documents
- metadata catalog entries
- blob assets under `assets/`
- config registries under `config/*.json`

In other words, it is a document persistence layer with an app-level schema, not a Postgres schema.

## Important consequence for a migration

If we move to Postgres, this is not a small one-file switch. The real work is replacing the current storage interface and migrating the current logical model into tables.

The architecture currently assumes:

- storage is path-based and document-based
- resource identity is a file ID
- metadata is a JSON catalog that can be read and written wholesale
- the same abstraction can run against local files, S3, GCS, or Adobe I/O Files

A Postgres migration would need to preserve these semantics or rework the application model to a relational schema.

## Practical handoff note for Chauncey / Claude

Current state:

- no Postgres DB in this repo
- no Postgres container in Docker Compose
- no `pgdata` directory
- no DB file in the repo
- persistence is filesystem/blob/object store based

This repo is therefore not “already using Chauncey’s DB”; it is currently a document-store architecture that is intentionally designed to avoid a second relational persistence layer.

## Summary

The current architecture is:

- app code: Node service
- persistence: object/document storage via a pluggable storage layer
- default local backend: filesystem at `/data`
- data files: JSON under `resources/` and related directories
- database: none
- Postgres: not yet introduced or configured

This is the architecture to preserve in mind while planning the migration to a relational database.
