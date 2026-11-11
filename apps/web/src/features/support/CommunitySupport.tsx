import { useRef, useState } from 'react'
import { useRouter } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { ApiProblem } from '../../api/client'
import type { components } from '../../api/schema'
import { useAuthLifetime } from '../../auth/AuthProvider'
import { Button } from '../../ui/Button/Button'
import { Card } from '../../ui/Card/Card'
import { InlineAlert } from '../../ui/InlineAlert/InlineAlert'
import { communitySupportHref, createCommunitySupportTicket } from './communitySupportClient'
import { communitySupportCopy } from './communitySupportMessages'

export function CommunitySupport({ organisationId }: { organisationId: string | undefined }) {
  const { i18n } = useTranslation()
  const copy = communitySupportCopy(i18n.resolvedLanguage)
  const router = useRouter()
  const lifetime = useAuthLifetime()
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')
  const [pending, setPending] = useState(false)
  const [joining, setJoining] = useState(false)
  const [error, setError] = useState<'error' | 'limited' | undefined>()
  const [receipt, setReceipt] = useState<components['schemas']['CommunitySupportTicketReceipt']>()
  const retry = useRef<{ payload: string; key: string } | undefined>(undefined)
  const current = (stamp: object) =>
    lifetime.hasUsableCredential() && lifetime.getRetirementStamp() === stamp
  async function join() {
    if (!organisationId || joining) return
    const stamp = lifetime.getRetirementStamp()
    setJoining(true)
    setError(undefined)
    try {
      const href = await communitySupportHref(organisationId)
      if (current(stamp)) await router.navigate({ href })
    } catch {
      if (current(stamp)) setError('error')
    } finally {
      if (current(stamp)) setJoining(false)
    }
  }
  async function send() {
    if (pending || !organisationId) return
    const stamp = lifetime.getRetirementStamp()
    const locale = i18n.resolvedLanguage?.startsWith('en') ? 'en' : 'fr'
    const payload = JSON.stringify([subject.trim(), body.trim(), locale])
    if (retry.current?.payload !== payload) retry.current = { payload, key: crypto.randomUUID() }
    setPending(true)
    setError(undefined)
    setReceipt(undefined)
    try {
      const result = await createCommunitySupportTicket(
        subject.trim(),
        body.trim(),
        locale,
        retry.current.key
      )
      if (current(stamp)) {
        setReceipt(result)
        setSubject('')
        setBody('')
        retry.current = undefined
      }
    } catch (failure) {
      if (current(stamp))
        setError(failure instanceof ApiProblem && failure.status === 429 ? 'limited' : 'error')
    } finally {
      if (current(stamp)) setPending(false)
    }
  }
  return (
    <Card>
      <section aria-labelledby="community-support-title" className="flex flex-col gap-4 p-4">
        <h2 id="community-support-title" className="text-sm font-semibold text-c-ink">
          {copy.title}
        </h2>
        <p className="text-sm text-c-ink-2">{copy.body}</p>
        {organisationId === undefined ? (
          <p className="text-sm text-c-ink-2">{copy.unavailable}</p>
        ) : (
          <>
            <Button
              variant="secondary"
              className="self-start"
              disabled={joining}
              onClick={() => void join()}
            >
              {copy.join}
            </Button>
            <form
              className="flex flex-col gap-3"
              onSubmit={(event) => {
                event.preventDefault()
                void send()
              }}
            >
              <label
                className="flex flex-col gap-2 text-sm text-c-ink"
                htmlFor="community-support-subject"
              >
                {copy.subject}
                <input
                  id="community-support-subject"
                  required
                  minLength={3}
                  maxLength={200}
                  value={subject}
                  disabled={pending}
                  onChange={(event) => setSubject(event.target.value)}
                  className="focus-visible:outline-c-accent rounded-md border border-c-border bg-c-surface p-3 text-c-ink focus-visible:outline-2"
                />
              </label>
              <label
                className="flex flex-col gap-2 text-sm text-c-ink"
                htmlFor="community-support-body"
              >
                {copy.description}
                <textarea
                  id="community-support-body"
                  required
                  minLength={10}
                  maxLength={20000}
                  rows={5}
                  value={body}
                  disabled={pending}
                  aria-describedby="community-support-privacy"
                  onChange={(event) => setBody(event.target.value)}
                  className="focus-visible:outline-c-accent rounded-md border border-c-border bg-c-surface p-3 text-c-ink focus-visible:outline-2"
                />
              </label>
              <p id="community-support-privacy" className="text-xs text-c-ink-3">
                {copy.privacy}
              </p>
              <Button
                type="submit"
                className="self-start"
                disabled={pending || subject.trim().length < 3 || body.trim().length < 10}
              >
                {copy.send}
              </Button>
              {pending ? (
                <p role="status" className="text-sm text-c-ink-2">
                  {copy.pending}
                </p>
              ) : null}
            </form>
          </>
        )}
        {error ? <InlineAlert kind="error">{copy[error]}</InlineAlert> : null}
        {receipt ? (
          <div role="status" className="flex flex-col gap-2 text-sm text-c-ink">
            <p>{copy.success}</p>
            <p>
              {copy.ticket}: {receipt.id}
            </p>
            <p>
              {copy.priority}: {receipt.priority}
            </p>
          </div>
        ) : null}
      </section>
    </Card>
  )
}
