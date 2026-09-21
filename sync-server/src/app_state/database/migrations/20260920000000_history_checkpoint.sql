-- Tokens identify an event's incarnation, including when a restored backup
-- reuses its numeric ID or a client resubmits the same request UUID.
ALTER TABLE events ADD COLUMN event_token TEXT;
UPDATE events SET event_token = lower(hex(randomblob(16)));
