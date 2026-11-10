import { act, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { getLocalProfile, updateLocalProfile, useLocalProfile } from './localProfile'

const ID = '@profile-test:community.kodera.io'
afterEach(() => localStorage.removeItem(`kodera.profile.${ID}`))

it('persists profile changes by Matrix identity and updates all mounted subscribers', () => {
  function Preview() {
    const { profile } = useLocalProfile(ID)
    return (
      <p>
        {profile.displayName} {profile.presence} {profile.status}
      </p>
    )
  }
  render(
    <>
      <Preview />
      <Preview />
    </>
  )
  act(() =>
    updateLocalProfile(ID, { displayName: 'River', presence: 'focused', status: 'Reviewing' })
  )
  expect(screen.getAllByText('River focused Reviewing')).toHaveLength(2)
  expect(getLocalProfile(ID)).toEqual({
    displayName: 'River',
    presence: 'focused',
    status: 'Reviewing',
  })
  expect(getLocalProfile('@other:community.kodera.io').displayName).toBe('')
})

it('ignores malformed persisted data and bounds user supplied text', () => {
  localStorage.setItem(`kodera.profile.${ID}`, '{broken')
  expect(getLocalProfile(ID).presence).toBe('online')
  updateLocalProfile(ID, { displayName: 'a'.repeat(100), status: 'b'.repeat(200) })
  expect(getLocalProfile(ID).displayName).toHaveLength(80)
  expect(getLocalProfile(ID).status).toHaveLength(160)
})
