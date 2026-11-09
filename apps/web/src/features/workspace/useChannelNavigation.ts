import { useNavigate, useRouterState } from '@tanstack/react-router'

/**
 * The live workspace's channel choice, made the address — that channel's route — and whether the
 * router is between two addresses, during which the view sends nothing.
 */
export function useChannelNavigation(org: string) {
  const navigate = useNavigate()
  const navigationPending = useRouterState({ select: (state) => state.status === 'pending' })
  return {
    onNavigateChannel: (channelId: string) =>
      navigate({ to: '/$org/workspace/$channelId', params: { org, channelId } }),
    navigationPending,
  }
}
