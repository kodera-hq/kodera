// A member chosen by name: the moderator types part of a name or address, Core searches the
// directory, and one of the people found is picked. No identifier is ever typed or shown.

import { useId, useMemo, useState } from 'react'
import { Avatar } from '../../../ui/Avatar/Avatar'
import { Button } from '../../../ui/Button/Button'
import { CloseIcon } from '../../../ui/icons/Close'
import { useDirectory } from '../admin/membersApi'
import { memberName } from '../admin/WorkspaceMembersPanel'
import { useAdminCopy } from '../admin/shared'

export interface PickedMember {
  id: string
  name: string
}

export function MemberPicker({
  organisationId,
  value,
  onChange,
}: {
  organisationId: string
  value: PickedMember | null
  onChange: (member: PickedMember | null) => void
}) {
  const copy = useAdminCopy()
  const id = useId()
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const members = useDirectory(organisationId, query)
  const options = useMemo(
    () =>
      (members.data?.pages ?? [])
        .flatMap((page) => page.data)
        .filter((member) => member.state === 'active' || member.state === 'suspended')
        .slice(0, 8)
        .map((member) => ({ id: member.id, name: memberName(member, copy.unnamed) })),
    [members.data, copy.unnamed]
  )

  if (value !== null)
    return (
      <div className="flex flex-col gap-1">
        <span className="text-sm font-medium" id={`${id}-label`}>
          {copy.pickMember}
        </span>
        <div
          aria-labelledby={`${id}-label`}
          role="group"
          className="flex items-center gap-3 rounded-md border border-c-border px-3 py-2"
        >
          <Avatar name={value.name} identity={value.id} size="xs" />
          <span className="min-w-0 flex-1 truncate text-sm font-semibold">{value.name}</span>
          <Button
            variant="tertiary"
            size="sm"
            iconOnly
            icon={<CloseIcon />}
            aria-label={copy.pickMemberClear(value.name)}
            onClick={() => onChange(null)}
          />
        </div>
      </div>
    )

  const choose = (option: PickedMember) => {
    onChange(option)
    setQuery('')
    setOpen(false)
  }
  const listId = `${id}-list`
  const showList = open && query.trim() !== ''
  return (
    <div className="relative flex flex-col gap-1">
      <label htmlFor={`${id}-input`} className="text-sm font-medium">
        {copy.pickMember}
      </label>
      <input
        id={`${id}-input`}
        type="search"
        role="combobox"
        autoComplete="off"
        aria-expanded={showList}
        aria-controls={listId}
        aria-autocomplete="list"
        {...(showList && options[active] !== undefined
          ? { 'aria-activedescendant': `${listId}-${options[active].id}` }
          : {})}
        placeholder={copy.pickMemberPlaceholder}
        value={query}
        onChange={(event) => {
          setQuery(event.target.value)
          setActive(0)
          setOpen(true)
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') {
            event.preventDefault()
            setActive((n) => Math.min(n + 1, Math.max(0, options.length - 1)))
          } else if (event.key === 'ArrowUp') {
            event.preventDefault()
            setActive((n) => Math.max(0, n - 1))
          } else if (event.key === 'Enter') {
            const option = options[active]
            if (option !== undefined) {
              event.preventDefault()
              choose(option)
            }
          } else if (event.key === 'Escape' && showList) {
            event.stopPropagation()
            setOpen(false)
          }
        }}
        className="h-10 rounded-md border border-c-border-input bg-c-surface px-3 text-sm text-c-ink placeholder:text-c-placeholder focus-visible:ring focus-visible:outline-hidden narrow:min-h-[44px]"
      />
      {showList ? (
        <ul
          id={listId}
          role="listbox"
          aria-label={copy.pickMember}
          className="z-10 mt-1 flex max-h-[256px] flex-col overflow-y-auto rounded-md border border-c-border bg-c-elevated p-1 shadow-pop shadow-c-shadow-2"
        >
          {options.length === 0 ? (
            <li role="presentation" className="px-3 py-2 text-sm text-c-ink-3">
              {members.isFetching ? copy.loading : copy.noMatch}
            </li>
          ) : (
            options.map((option, index) => (
              // Keyboard selection is handled on the input (ArrowUp/Down, Enter); this `onClick`
              // is the pointer path onto the same choice.
              // eslint-disable-next-line jsx-a11y/click-events-have-key-events
              <li
                key={option.id}
                id={`${listId}-${option.id}`}
                role="option"
                aria-selected={index === active}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => choose(option)}
                className="flex min-h-10 cursor-pointer items-center gap-2 rounded-sm px-3 py-2 text-sm aria-selected:bg-c-accent-soft aria-selected:text-c-accent-ink"
              >
                <Avatar name={option.name} identity={option.id} size="xs" />
                <span className="truncate">{option.name}</span>
              </li>
            ))
          )}
        </ul>
      ) : null}
    </div>
  )
}
