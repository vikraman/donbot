import fc from 'fast-check'

// fixed seed; FC_SEED=random to explore
const seed = process.env.FC_SEED === 'random' ? Date.now() : Number(process.env.FC_SEED ?? 20261121)
fc.configureGlobal({ seed, numRuns: Number(process.env.FC_RUNS ?? 200) })

export { fc }

// dst, half-hour and southern-hemisphere zones
export const ZONES = ['UTC', 'Europe/London', 'America/New_York', 'Asia/Kolkata', 'Australia/Lord_Howe', 'Pacific/Chatham', 'America/Sao_Paulo', 'Asia/Tokyo'] as const
export const zone = fc.constantFrom(...ZONES)

// minute-aligned instants, 2000-2100
export const instant = fc.integer({ min: 946_684_800_000 / 60_000, max: 4_102_444_800_000 / 60_000 }).map(m => m * 60_000)

export const hour = fc.integer({ min: 0, max: 23 })
export const minute = fc.integer({ min: 0, max: 59 })

export const weekdays = fc.uniqueArray(fc.integer({ min: 0, max: 6 }), { minLength: 1, maxLength: 7 }).map(d => d.sort())
