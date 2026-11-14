// Existing Order catalogue failure: the contract declares internal-error.
import { http } from 'msw/http'
import { PROBLEM_TYPES } from '../generated/problems'
import { problem } from '../problem'

const INTERNAL_ERROR = PROBLEM_TYPES.find((type) => type.endsWith('/internal-error'))

export const handlers = [
  http.get('*/api/v1/catalog/capacity-tiers', () => {
    if (INTERNAL_ERROR === undefined) throw new Error('The contract lost internal-error.')
    return problem(INTERNAL_ERROR)
  }),
]
