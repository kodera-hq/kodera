# Server changelog

Status: Active

## Unreleased

- Organisation object erasure now requires `s3:ListBucket` scoped to
  `organisations/<org>/attachments/`, in addition to object deletion and absence verification.
  Grant this permission to the media worker credential before upgrading; erasures remain held
  until listing succeeds. Account erasure keeps its individual-key scope. Periodic orphan
  reconciliation is tracked in [kodera#253](https://github.com/kodera-hq/kodera/issues/253).
- API body admission reserves half of each gthread worker for bodyless requests, with a
  10-second absolute body-read deadline, a 1 MiB limit and immediate capacity refusal.
