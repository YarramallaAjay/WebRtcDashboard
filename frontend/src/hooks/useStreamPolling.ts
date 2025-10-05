import { useState, useEffect, useCallback, useRef } from 'react'
import axios from 'axios'

interface StreamStatus {
  ready: boolean
  status: string
  pathName?: string
}

export function useStreamPolling(
  cameraId: string,
  apiBaseUrl: string,
  enabled: boolean = false,
  pollingInterval: number = 1000 // 1 second
) {
  const [streamStatus, setStreamStatus] = useState<StreamStatus>({
    ready: false,
    status: 'OFFLINE',
  })
  const [isPolling, setIsPolling] = useState(false)
  const pollingRef = useRef<NodeJS.Timeout>()

  const checkStreamStatus = useCallback(async () => {
    if (!enabled || !cameraId) return

    try {
      const response = await axios.get(
        `${apiBaseUrl}/cameras/${cameraId}/status`,
        { timeout: 3000 }
      )

      const camera = response.data.camera
      const ready = camera.status === 'PROCESSING' && camera.enabled

      setStreamStatus({
        ready,
        status: camera.status,
        pathName: camera.mediamtxPath,
      })

      // Stop polling once stream is ready
      if (ready) {
        setIsPolling(false)
        if (pollingRef.current) {
          clearInterval(pollingRef.current)
          pollingRef.current = undefined
        }
      }
    } catch (error) {
      console.error('Error checking stream status:', error)
    }
  }, [cameraId, apiBaseUrl, enabled])

  useEffect(() => {
    if (!enabled || !cameraId) {
      setIsPolling(false)
      if (pollingRef.current) {
        clearInterval(pollingRef.current)
        pollingRef.current = undefined
      }
      return
    }

    // Initial check
    checkStreamStatus()

    // Start polling
    setIsPolling(true)
    pollingRef.current = setInterval(checkStreamStatus, pollingInterval)

    return () => {
      if (pollingRef.current) {
        clearInterval(pollingRef.current)
        pollingRef.current = undefined
      }
      setIsPolling(false)
    }
  }, [cameraId, enabled, pollingInterval, checkStreamStatus])

  return { streamStatus, isPolling, checkStreamStatus }
}
