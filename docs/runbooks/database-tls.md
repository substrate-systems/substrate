# Interactive database TLS

Exomem's interactive PostgreSQL transactions verify both the certificate chain
and the database peer's DNS name or IP address. Both transaction entrypoints
use this policy. Ordinary Neon HTTP queries continue to use the Neon driver.

Existing PostgreSQL URLs with `sslmode=require` or `sslmode=verify-full` work;
URLs without an SSL mode also require verified TLS. System certificate roots
are used by default. A private database CA can be supplied with `sslrootcert`
in the URL; `sslcert` and `sslkey` remain available for client authentication.
Keep those files outside public artifacts and readable only by the service.

The client rejects disabled verification, fallback SSL modes, duplicate
parameters, and query parameters that override the URL's host, port or
credentials. `NODE_TLS_REJECT_UNAUTHORIZED=0` is refused. Configuration errors
use `DATABASE_TRANSPORT_*` codes without echoing the connection string.

For a disposable local PostgreSQL instance, explicitly set
`DATABASE_ALLOW_INSECURE_LOOPBACK=true` and use `sslmode=disable` with
`127.0.0.1` or `::1`, with `NODE_ENV=development` or `NODE_ENV=test`.
Production, unset and unknown environments refuse this exception.
DNS names, including `localhost`, cannot use the exception. Production
configuration must leave the exception unset.

Run the handshake and policy checks with:

```sh
node --import tsx --test 'src/lib/__tests__/database-transport*.test.ts'
```

The tests create temporary synthetic certificates and TCP peers. They exercise
both application transaction entrypoints and prove certificate failures occur
before PostgreSQL startup or password transmission.
