# Linkly

Linkly turns long web addresses into short links and tracks visits. It uses Node.js and PostgreSQL.

## Set up locally

You need Node.js 20.19 or newer and a running PostgreSQL server.

```sh
npm install
createdb linkly
createdb linkly_test
cp .env.example .env
```

Edit `.env` and set both database URLs to match your PostgreSQL username and password. Keep `TEST_DATABASE_URL` pointed at the separate `linkly_test` database: the test suite clears its tables.
Remote database connections use TLS with certificate verification; local loopback connections retain PostgreSQL's default SSL settings.
If a remote database uses a private or self-signed certificate, set `DATABASE_SSL_CA` to the database provider's CA certificate in PEM format. Newlines may be represented as `\n` in a single-line environment variable. The CA is trusted without disabling certificate verification.
If the database CA is already installed in the operating system trust store, Node versions that support `--use-system-ca` can use it with `NODE_OPTIONS=--use-system-ca npm start`.

Start the app:

```sh
npm start
```

On startup, Linkly creates the tables and adds a sample `welcome` link to `https://example.com`. The API is available at `http://localhost:3000`, Swagger UI at `/docs`, and the health check at `/health`.

Run the tests:

```sh
npm test
npm run lint
```

Never point `TEST_DATABASE_URL` at a production database.

## Deploy to Vercel

The root `index.js` exports the Express app for Vercel. The existing `npm start`
command remains the local long-running server.

1. Push the project to GitHub and import the repository in Vercel. Select the
   branch you want to deploy. Vercel should detect the Express app automatically.
2. Create a PostgreSQL database that is reachable from Vercel (for example, with
   a managed PostgreSQL provider) and set `DATABASE_URL` in the Vercel project's
   environment variables to its connection URL.
3. Before opening the deployed app, run the contents of `db/schema.sql` once
   against that database using your provider's SQL editor or `psql`. Optionally
   run `db/seed.sql` to add the sample `welcome` link. Do not run these against
   your local or test database by mistake.
4. Optionally set `PUBLIC_BASE_URL` to the public URL you want included in
   created links. If it is unset, the app uses Vercel's deployment URL when
   available.
5. Deploy, then check `/health` on the deployed URL. It should return
   `{"status":"ok"}` when the database is reachable and the schema is installed.

Do not set `TEST_DATABASE_URL` on the production deployment. Keep it pointed at
a separate disposable database for local tests.

## Deploy to Render

The web service requires a reachable PostgreSQL database; Render does not run
one automatically alongside the Node.js service. Create or choose a PostgreSQL
database, then add an environment variable named `DATABASE_URL` to the Render
web service. Use the database's **Internal Database URL** when both services
are in the same Render region, or its external connection URL otherwise. Do not
use `localhost`: that points to the web service itself, not the database.

After saving the variable, redeploy or restart the web service. Startup creates
the schema and seeds the sample link. Keep `TEST_DATABASE_URL` unset in the
production service.

## API

| Method | Path | Behavior |
| --- | --- | --- |
| `POST` | `/links` | Create `{ "target_url": "https://example.com", "expires_at": "optional ISO date-time" }`; Linkly generates the short code |
| `GET` | `/:code` | Redirect with 302 and record a click; 404 if unknown, 410 if expired |
| `GET` | `/links/:code` | Get the target, timestamps, and click count |
| `GET` | `/links/:code/clicks?after=&limit=` | Read clicks page by page (limit 1–100, default 50); response includes `next_cursor` |
| `GET` | `/links/:code/clicks.csv` | Download the click log as CSV |
| `DELETE` | `/links/:code` | Delete a link and its clicks |
| `GET` | `/health` | Return 200 when PostgreSQL is available, or 503 when it is unavailable |
| `GET` | `/docs` | Open the Swagger API documentation |

Only valid `http` and `https` target URLs are accepted. Invalid requests return a plain-language message and identify the field to correct. SQL queries use parameters instead of inserting user input into query text.

Redirects update the click count atomically and save the click record in the same transaction, so concurrent visits are not lost. The unique constraint on `links.code` provides the indexed redirect lookup. To inspect the query plan, run this in `psql`:

```sql
EXPLAIN SELECT id, target_url FROM links WHERE code = 'welcome';
```

PostgreSQL may choose a sequential scan when the table is small; with more links, the unique index is used for lookup.
