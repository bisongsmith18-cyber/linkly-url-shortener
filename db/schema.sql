CREATE TABLE IF NOT EXISTS links (
    id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    code VARCHAR(16) UNIQUE NOT NULL
        CHECK (code ~ '^[A-Za-z0-9_-]{3,16}$'),
    target_url TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ,
    click_count INTEGER NOT NULL DEFAULT 0 CHECK (click_count >= 0)
);

CREATE TABLE IF NOT EXISTS clicks (
    id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    link_id INTEGER NOT NULL REFERENCES links(id) ON DELETE CASCADE,
    clicked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    referrer TEXT,
    user_agent TEXT
);

CREATE INDEX IF NOT EXISTS clicks_link_clicked_id_idx
    ON clicks (link_id, clicked_at, id);
