INSERT INTO links (code, target_url)
VALUES ('welcome', 'https://example.com')
ON CONFLICT (code) DO NOTHING;
