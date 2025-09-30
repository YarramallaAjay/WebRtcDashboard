import { useEffect, useRef, useState } from 'react'
import axios from 'axios'

export interface CameraStream {
  id: string
  name: string
  location?: string
  status: string
  pathName: string
  webrtcUrl: string
  enabled: boolean
}

interface CameraTileProps {
  camera: CameraStream
  mediamtxUrl: string
}

export default function CameraTile({ camera, mediamtxUrl }: CameraTileProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const peerConnectionRef = useRef<RTCPeerConnection | null>(null)
  const [connectionState, setConnectionState] = useState<RTCPeerConnectionState>('new')
  const [isConnecting, setIsConnecting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const reconnectTimeoutRef = useRef<NodeJS.Timeout>()
  const retryCountRef = useRef<number>(0)
  const maxRetries = 5

  const iceServers = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ]

  const cleanup = () => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current)
    }
    if (peerConnectionRef.current) {
      peerConnectionRef.current.close()
      peerConnectionRef.current = null
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null
    }
  }

  // Calculate exponential backoff delay
  const getRetryDelay = (retryCount: number): number => {
    const delays = [5000, 10000, 20000, 30000, 60000] // 5s, 10s, 20s, 30s, 60s
    return delays[Math.min(retryCount, delays.length - 1)]
  }

  const waitForIceGathering = (pc: RTCPeerConnection) => {
    if (pc.iceGatheringState === 'complete') return Promise.resolve()
    return new Promise<void>((resolve) => {
      const check = () => {
        if (pc.iceGatheringState === 'complete') {
          pc.removeEventListener('icegatheringstatechange', check)
          resolve()
        }
      }
      pc.addEventListener('icegatheringstatechange', check)
      setTimeout(resolve, 5000) // Max 5s wait
    })
  }

  const connectWebRTC = async () => {
    if (isConnecting || !camera.enabled || camera.status !== 'PROCESSING') return

    setIsConnecting(true)
    setError(null)

    try {
      const pc = new RTCPeerConnection({
        iceServers,
        iceCandidatePoolSize: 10,
        bundlePolicy: 'max-bundle',
      })
      peerConnectionRef.current = pc

      // Log ICE candidates
      pc.onicecandidate = (event) => {
        if (event.candidate) {
          console.log(`[${camera.name}] ICE candidate:`, event.candidate.candidate)
        } else {
          console.log(`[${camera.name}] ICE gathering complete`)
        }
      }

      pc.onicegatheringstatechange = () => {
        console.log(`[${camera.name}] ICE gathering state:`, pc.iceGatheringState)
      }

      pc.oniceconnectionstatechange = () => {
        console.log(`[${camera.name}] ICE connection state:`, pc.iceConnectionState)
      }

      pc.onconnectionstatechange = () => {
        console.log(`[${camera.name}] Connection state:`, pc.connectionState)
        setConnectionState(pc.connectionState)

        if (pc.connectionState === 'connected') {
          // Reset retry count on successful connection
          retryCountRef.current = 0
          setError(null)
        } else if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
          // Auto-retry with exponential backoff
          if (retryCountRef.current < maxRetries) {
            const delay = getRetryDelay(retryCountRef.current)
            console.log(`[${camera.name}] Retrying connection in ${delay}ms (attempt ${retryCountRef.current + 1}/${maxRetries})`)
            retryCountRef.current++

            reconnectTimeoutRef.current = setTimeout(() => {
              if (camera.enabled && camera.status === 'PROCESSING') {
                connectWebRTC()
              }
            }, delay)
          } else {
            console.log(`[${camera.name}] Max retries reached, giving up`)
            setError(`Connection failed after ${maxRetries} attempts`)
          }
        }
      }

      pc.addTransceiver('video', { direction: 'recvonly' })
      pc.addTransceiver('audio', { direction: 'recvonly' })

      pc.ontrack = (event) => {
        if (videoRef.current && event.streams[0]) {
          videoRef.current.srcObject = event.streams[0]
          videoRef.current.play().catch(() => {})
        }
      }

      const offer = await pc.createOffer()
      await pc.setLocalDescription(offer)
      await waitForIceGathering(pc)

      const whepUrl = `${mediamtxUrl}/${encodeURIComponent(camera.pathName)}/whep`
      const response = await axios.post(whepUrl, pc.localDescription?.sdp, {
        headers: { 'Content-Type': 'application/sdp' },
        timeout: 10000,
      })

      await pc.setRemoteDescription(
        new RTCSessionDescription({ type: 'answer', sdp: response.data })
      )
    } catch (err: any) {
      console.error(`WebRTC error for ${camera.name}:`, err)
      // Extract error message properly
      let errorMsg = 'Connection failed'
      if (err.response?.data) {
        errorMsg = typeof err.response.data === 'string' ? err.response.data : JSON.stringify(err.response.data)
      } else if (err.message) {
        errorMsg = err.message
      }
      setError(errorMsg)
      cleanup()

      // Retry with exponential backoff
      if (retryCountRef.current < maxRetries) {
        const delay = getRetryDelay(retryCountRef.current)
        console.log(`[${camera.name}] Retrying after error in ${delay}ms (attempt ${retryCountRef.current + 1}/${maxRetries})`)
        retryCountRef.current++

        reconnectTimeoutRef.current = setTimeout(() => {
          if (camera.enabled && camera.status === 'PROCESSING') {
            connectWebRTC()
          }
        }, delay)
      } else {
        console.log(`[${camera.name}] Max retries reached after error`)
        setError(`${errorMsg} (after ${maxRetries} attempts)`)
      }
    } finally {
      setIsConnecting(false)
    }
  }

  useEffect(() => {
    if (camera.enabled && camera.status === 'PROCESSING') {
      // Reset retry count when camera changes
      retryCountRef.current = 0
      // Increased delay to ensure MediaMTX stream is ready (from 2s to 5s)
      const timer = setTimeout(() => connectWebRTC(), 5000)
      return () => {
        clearTimeout(timer)
        cleanup()
      }
    } else {
      cleanup()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camera.id, camera.enabled, camera.status, camera.pathName])

  const statusColor =
    connectionState === 'connected'
      ? 'bg-green-500'
      : connectionState === 'connecting'
      ? 'bg-yellow-500'
      : 'bg-red-500'

  return (
    <div className="bg-gray-800 rounded-lg overflow-hidden shadow-lg">
      {/* Header */}
      <div className="bg-gray-700 px-3 py-2 flex items-center justify-between">
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-semibold text-white truncate">{camera.name}</h3>
          {camera.location && (
            <p className="text-xs text-gray-400 truncate">{camera.location}</p>
          )}
        </div>
        <div className={`w-2 h-2 rounded-full ${statusColor} ml-2`}></div>
      </div>

      {/* Video */}
      <div className="relative aspect-video bg-black">
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          className="w-full h-full object-cover"
        />

        {/* Overlays */}
        {!camera.enabled && (
          <div className="absolute inset-0 bg-gray-900/90 flex items-center justify-center">
            <p className="text-gray-400 text-sm">Camera Offline</p>
          </div>
        )}

        {isConnecting && (
          <div className="absolute inset-0 bg-black/50 flex items-center justify-center">
            <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-blue-400"></div>
          </div>
        )}

        {error && (
          <div className="absolute bottom-0 left-0 right-0 bg-red-600/90 px-2 py-1">
            <p className="text-xs text-white truncate">{error}</p>
          </div>
        )}

        {connectionState === 'connected' && (
          <div className="absolute top-2 right-2">
            <div className="bg-red-600 text-white px-2 py-0.5 rounded text-xs font-semibold">
              ● LIVE
            </div>
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="bg-gray-700 px-3 py-2 text-xs text-gray-400">
        <div className="flex items-center justify-between">
          <span>{camera.status}</span>
          <span>{connectionState}</span>
        </div>
      </div>
    </div>
  )
}