import { useCallback, useState } from 'react'
import { TOUR_SECTIONS, type TourSection } from './tutorial'

export const TOUR_KEY = 'dixvoice.tutorial.explained'

function load(): Set<TourSection> {
  try {
    const raw = localStorage.getItem(TOUR_KEY)
    const list: unknown = raw ? JSON.parse(raw) : []
    const valid = new Set<string>(TOUR_SECTIONS)
    return new Set(Array.isArray(list) ? list.filter((s): s is TourSection => typeof s === 'string' && valid.has(s)) : [])
  } catch {
    return new Set()
  }
}

function save(explained: Set<TourSection>) {
  try {
    localStorage.setItem(TOUR_KEY, JSON.stringify([...explained]))
  } catch {
    return
  }
}

/** Which page sections the guided tour has already explained on this device. */
export function useTour() {
  const [explained, setExplained] = useState<Set<TourSection>>(load)

  const update = useCallback((next: (prev: Set<TourSection>) => Set<TourSection>) => {
    setExplained((prev) => {
      const value = next(prev)
      save(value)
      return value
    })
  }, [])

  const markExplained = useCallback((section: TourSection) => update((prev) => new Set(prev).add(section)), [update])
  const skipTour = useCallback(() => update(() => new Set(TOUR_SECTIONS)), [update])
  const replayTour = useCallback(() => update(() => new Set()), [update])

  return { explained, markExplained, skipTour, replayTour }
}
