# Showcase Neon Database Boundary

Verified: 2026-08-30

The initial Neon foundation stores immutable snapshots of the sanitized `showcase-public-v2`
contract. It does not connect the public site or the local publisher to Neon yet. The existing local
JSON publication path remains active until a separate integration milestone changes it.

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

Do not rerun the bootstrap or use `--rotate` without an explicit credential-rotation decision. A
rotation changes both generated passwords and replaces both local application credential files.
