import { useEffect, useState } from 'react'
import { onPlayingChange } from './audio'

export function usePlayingKey(): string | null {
  const [key, setKey] = useState<string | null>(null)
  useEffect(() => onPlayingChange(setKey), [])
  return key
}
