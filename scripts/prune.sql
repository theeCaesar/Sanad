-- Housekeeping. Run nightly from a K8s CronJob.
--
-- Every one of these tables grows forever if left alone. That is invisible for
-- six months and then is suddenly a 40GB table and a 3am page.

-- 1. Published outbox rows. Once an event is in Kafka, the row has done its job.
--    Keep 7 days for forensics ("did we actually publish that?"), then drop.
DELETE FROM outbox
 WHERE status = 'published'
   AND published_at < now() - interval '7 days';

-- 2. Consumer-side dedupe records. Kafka's own retention means an event older
--    than the retention window can never be redelivered — so there is nothing
--    left to dedupe against, and the row is dead weight.
DELETE FROM processed_events
 WHERE processed_at < now() - interval '14 days';

-- 3. Abandoned demo orgs. ON DELETE CASCADE does the actual work.
DELETE FROM orgs
 WHERE slug LIKE 'demo-%'
   AND created_at < now() - interval '1 hour';

-- 4. Completed sagas. Keep FAILED ones FOREVER — those are the ones where a
--    compensation did not work, money moved and could not be moved back, and a
--    human still owes someone an explanation. Never delete evidence of a
--    problem you have not solved.
DELETE FROM sagas
 WHERE state IN ('completed', 'compensated')
   AND updated_at < now() - interval '30 days';

-- NEVER prune `mutations`. It is the audit trail, the idempotency store, and
--   the replay log. A driver disputing a delivery six months later is exactly
--   when you need it, and it is exactly when it will be gone if you were
--   clever about disk space.
--
--   If it genuinely grows too large: PARTITION by month and move old partitions
--   to cheaper storage. Do not DELETE.

VACUUM ANALYZE outbox;
VACUUM ANALYZE processed_events;
