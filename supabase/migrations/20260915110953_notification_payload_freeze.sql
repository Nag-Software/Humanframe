-- Retry safety for notification sending.
--
-- Resend deduplicates on Idempotency-Key *and* the request body: the same key
-- with a modified body is refused with 409. A retry must therefore send exactly
-- what the first attempt sent — same recipient, same sender, same subject, same
-- html. Anything that could drift between attempts (the user's address, a
-- commitment's title, the configured sender) is frozen at the first attempt and
-- replayed verbatim afterwards.
--
-- The 24-hour deduplication window is counted from that first attempt, not from
-- the row's creation: a job created at 09:00 and first attempted at 20:00 has
-- its window run to 20:00 the next day.

alter table public.notification_outbox
  add column if not exists frozen_payload jsonb,
  add column if not exists frozen_at timestamptz,
  add column if not exists last_outcome text,
  add column if not exists review_reason text;

-- A job whose last attempt ended in an unknown state, and whose deduplication
-- window has since expired, must not be sent again on a guess: the provider can
-- no longer tell us whether the first one arrived. It is parked instead.
alter table public.notification_outbox
  drop constraint if exists notification_outbox_status_check;
alter table public.notification_outbox
  add constraint notification_outbox_status_check
    check (status in ('pending', 'sending', 'sent', 'failed', 'skipped',
                      'needs_review'));

comment on column public.notification_outbox.frozen_payload is
  'The exact request body sent on the first attempt. Replayed verbatim so the '
  'idempotency key always accompanies an identical payload.';
comment on column public.notification_outbox.frozen_at is
  'When the first send was attempted. The provider deduplication window runs '
  'from here.';
comment on column public.notification_outbox.last_outcome is
  'How the previous attempt ended: sent, duplicate, refused, retry or unknown.';
