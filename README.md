# Linkly

Linkly turns long web addresses into short links and tracks visits. It uses Node.js and PostgreSQL.

## Set up locally

You need Node.js 20 or newer and a running PostgreSQL server.

```sh
npm install
createdb linkly
createdb linkly_test
cp .env.example .env
```

Edit `.env` and set both database URLs to match your PostgreSQL username and password. Keep `TEST_DATABASE_URL` pointed at the separate `linkly_test` database: the test suite clears its tables.

Start the app:

```sh
npm start
```

On startup, Linkly creates the tables and adds a sample `welcome` link to `https://example.com`. The API is available at `http://localhost:3000`, Swagger UI at `/docs`, and the health check at `/health`.

Run the tests:

```sh
npm test
```

Never point `TEST_DATABASE_URL` at a production database.

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
