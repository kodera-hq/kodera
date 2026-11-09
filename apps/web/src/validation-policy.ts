import { z } from 'zod'

// Set before schema imports: even a caught capability probe violates strict CSP.
z.config({ jitless: true })
