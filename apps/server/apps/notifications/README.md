# Authenticated inbox and empty Web Push wakeups

Status: Implemented; production service release remains operator-controlled

Inbox entries contain a kind, resource identifier, timestamps and read state.
Current persisted membership and resource visibility govern every page and read
mutation. Cursors bind the issuer, subject, organisation and membership, expire
after an hour, and advance through a bounded scan even when policy hides entries.
A mark-read request accepts at most 200 unique identifiers and cannot update a
second member's inbox. Moderation audit events create the affected member's entry
in the producer's transaction. Other server modules use the explicit `record`
producer after authorizing their referenced resource.

A device subscription validates its HTTPS endpoint, P-256 public point and 16-byte
auth secret. DNS answers are checked when registering and pinned again when
sending. Subscription material is sealed with the shared AES-GCM primitive under
`KODERA_NOTIFICATION_SEAL_KEY`, with row, organisation, membership, device and
version as associated data. The setting is a 32-byte application key. The API
publishes only `KODERA_PUSH_VAPID_PUBLIC_KEY`; the VAPID private key is mounted into
the dispatcher worker alone.

`PushOutbox` records only a subscription and its version. Claims use skip-locked
rows, 30-second leases and at most ten attempts. The dispatcher checks current
account, membership, organisation and workspace eligibility before sending.
Replaced/revoked subscriptions and stale leases cannot apply an old result.
404/410 revokes only the exact subscription version; 429/5xx receives a bounded
retry. A provider redirect is refused. Terminal pruning is recorded as obsolete,
without claiming successful delivery.

The provider request has an empty body and VAPID authentication. It contains no
message, title, notification identifier or resource identifier. A wakeup causes the
client to fetch its inbox over authenticated HTTPS. There is no encrypted payload
to construct for this empty-body mode. The subscription's encryption keys remain
validated and sealed for protocol compatibility.

Run the bounded worker command `python manage.py dispatch_push --settings config.settings.deploy --key-file
/run/kodera/push-vapid.pem --subject mailto:operations@example.org --max-jobs 100`
in its separately provisioned worker process. It reloads the application signing
key for each claimed job and requires its public point to match discovery. The
API receives neither that file nor its contents. No worker credential or live
provider is provisioned by these source changes.

The tests inspect provider request bytes, verify VAPID signatures, exercise
current-member cursor/read boundaries and check dead-endpoint/replacement/lease
races against disposable PostgreSQL. All provider effects are owned test doubles.
