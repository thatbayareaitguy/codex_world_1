# Showcase Neon Database Boundary

Verified: 2026-09-02

Neon stores immutable snapshots of the sanitized `showcase-public-v3` contract. The local
publisher writes only through the validated security-definer function. The Showcase server reads
only the current public view. A generated JSON snapshot remains available as a local-development
fallback when Neon is absent.

## Schema and roles

The owner-only bootstrap creates the `showcase` schema and these SQL roles:

- `showcase_schema_owner` is a non-login object owner. Application credentials cannot assume it.
- `showcase_publisher` is an unprivileged login with `USAGE` on the schema, `SELECT` on
  `showcase.current_catalog`, and `EXECUTE` on
  `showcase.publish_catalog(text, timestamptz, text, jsonb)`. It has no direct table or sequence
  privilege and cannot create schema objects.
- `showcase_web_readonly` is an unprivileged login with `USAGE` on the schema and `SELECT` only on
  `showcase.current_catalog`. It cannot read the base snapshot table or execute the publish
  function.

`showcase.catalog_snapshots` is immutable to application roles. The security-definer publishing
function owns the only write path and validates the contract version, content hash, required
top-level public fields, exact top-level allowlist, timestamp agreement, and collection types. An
identical content hash resolves to the existing snapshot rather than creating a duplicate.

Contract v2 rows may remain as immutable history, but the publishing function accepts only v3.

The website credential uses Neon's pooled endpoint. The local publisher credential uses a direct
connection. Neon recommends pooled connections for application traffic and direct connections for
migrations and similar administrative work. See [Neon connection pooling](https://neon.com/docs/connect/connection-pooling), [Neon Postgres compatibility](https://neon.com/docs/reference/compatibility), and [PostgreSQL privileges](https://www.postgresql.org/docs/17/ddl-priv.html).

## Local credential files

The bootstrap does not print credentials and does not copy the owner URL. Generated credentials are
outside the repository with Windows ACL inheritance disabled. Only the current Windows user and
`SYSTEM` have explicit access.

| Purpose                  | Local file                                    | Variable                               |
| ------------------------ | --------------------------------------------- | -------------------------------------- |
| One-time owner bootstrap | `%LOCALAPPDATA%\Showcase\neon-owner.env`      | `SHOWCASE_NEON_OWNER_DATABASE_URL`     |
| Local publisher          | `%LOCALAPPDATA%\Showcase\neon-publisher.env`  | `SHOWCASE_NEON_PUBLISHER_DATABASE_URL` |
| Public website server    | `%LOCALAPPDATA%\Showcase\neon-public-web.env` | `SHOWCASE_NEON_PUBLIC_DATABASE_URL`    |

The website value is read-only but remains a server-side secret. Never place it in a
`NEXT_PUBLIC_*` variable or browser bundle. At deployment time, copy only that value into the
hosting platform's encrypted server-side secret manager. Do not deploy the owner or publisher
credential.

Store an encrypted recovery copy of the publisher and website files in the existing protected
OneDrive backup or a password manager. Keep the three roles in separate secret records so one can
be rotated without distributing the others. Do not commit any of these files.

## Commands

The completed initial bootstrap was run once with:

```powershell
pnpm showcase:neon:bootstrap
```

Normal permission verification does not read the owner file:

```powershell
pnpm showcase:neon:verify
```

Apply the v3 schema migration with the owner credential only when required:

```powershell
pnpm showcase:neon:migrate
```

Publish the validated scanner-derived snapshot through the restricted publisher role:

```powershell
pnpm showcase:publish
```

Verify content integrity and both application-role boundaries without the owner credential:

```powershell
pnpm showcase:neon:roundtrip
```

The round-trip command compares the normalized JSON fallback with the website's read-only Neon
result, validates the stored canonical hash, and confirms that direct publisher table writes,
website base-table reads, and website publishing are denied.

## Runtime and deployment

Local development resolves `SHOWCASE_NEON_PUBLIC_DATABASE_URL` from the process environment first,
then `%LOCALAPPDATA%\Showcase\neon-public-web.env`. If neither is configured, it reads the generated
JSON snapshot. `SHOWCASE_CATALOG_SOURCE=json` explicitly forces that fallback for tests.

For Vercel, store only `SHOWCASE_NEON_PUBLIC_DATABASE_URL` as an encrypted server-side environment
variable. Do not configure the owner or publisher URL. The application rejects the JSON fallback
when `VERCEL=1`, so a production deployment cannot silently serve a stale local snapshot. The URL
must identify the pooled `showcase_web_readonly` role and use TLS.

Do not rerun the bootstrap or use `--rotate` without an explicit credential-rotation decision. A
rotation changes both generated passwords and replaces both local application credential files.
