// WebRTCPlayer.tsx
import { useEffect, useRef, useState } from 'react'
import axios from 'axios'

export interface Camera {
  id: string
  name: string
  rtspUrl: string
  location?: string
  enabled: boolean
  status: string // e.g., 'processing' | 'CONNECTING' | ...
  createdAt: string
  workerInfo?: {
    pathName?: string
    sessionId?: string
  }
}

export interface WebRTCPlayerProps {
  camera: Camera
  workerUrl:string
  mediamtxUrl: string // e.g. http://your-mediatmx:8889

}

export default function WebRTCPlayer({
  camera,
  workerUrl,
  mediamtxUrl
  

}: WebRTCPlayerProps) {
  const iceServers = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
  ]
  const videoRef = useRef<HTMLVideoElement>(null)
  const peerConnectionRef = useRef<RTCPeerConnection | null>(null)
  const remoteStreamRef = useRef<MediaStream | null>(null)

  const [connectionState, setConnectionState] = useState<RTCPeerConnectionState>('new')
  const [iceState, setIceState] = useState<RTCIceConnectionState | 'new'>('new')
  const [isConnecting, setIsConnecting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Attach buffered stream to the <video> when it mounts/changes
  useEffect(() => {
    console.log(camera)
    const v = videoRef.current
    if (!v || !remoteStreamRef.current) return
    v.srcObject = remoteStreamRef.current
    v.play().catch((e) => console.warn('autoplay failed (will retry on user gesture):', e))
  }, [videoRef.current])

  // Clean up PC + tracks
  const stopWebRTCConnection = () => {
    try {
      if (peerConnectionRef.current) {
        try {
          peerConnectionRef.current.ontrack = null
          peerConnectionRef.current.onicecandidate = null
          peerConnectionRef.current.onconnectionstatechange = null
          peerConnectionRef.current.oniceconnectionstatechange = null
        } catch {}
        peerConnectionRef.current.getSenders?.().forEach((s) => s.track && s.track.stop())
        peerConnectionRef.current.getReceivers?.().forEach((r) => r.track && r.track.stop())
        peerConnectionRef.current.close()
        peerConnectionRef.current = null
      }
      if (remoteStreamRef.current) {
        remoteStreamRef.current.getTracks().forEach((t) => t.stop())
        remoteStreamRef.current = null
      }
      if (videoRef.current) {
        videoRef.current.srcObject = null
      }
      setConnectionState('closed')
      setIceState('new')
      setIsConnecting(false)
    } catch (e) {
      console.warn('stopWebRTCConnection error:', e)
    }
  }

  const waitForIceGatheringComplete = (pc: RTCPeerConnection) => {
    if (pc.iceGatheringState === 'complete') return Promise.resolve()
    return new Promise<void>((resolve) => {
      const check = () => {
        if (pc.iceGatheringState === 'complete') {
          pc.removeEventListener('icegatheringstatechange', check)
          resolve()
        }
      }
      pc.addEventListener('icegatheringstatechange', check)
    })
  }

  const buildWhepUrl = (base: string, pathName: string) => {
    
    return `${base}/${encodeURIComponent(pathName)}/whep`
  }

  const startWebRTCConnection = async () => {
    if (isConnecting) return
    setIsConnecting(true)
    setError(null)

    try {
      // Pick a MediaMTX path (from worker info or fallback)
      const pathName =
        camera.workerInfo?.pathName ||
        camera.workerInfo?.sessionId ||
        `camera_${camera.id}`

      const configuration: RTCConfiguration = {
        iceServers,
        iceCandidatePoolSize: 10,
        bundlePolicy: 'max-bundle',
        rtcpMuxPolicy: 'require',
      }

      const pc = new RTCPeerConnection(configuration)
      peerConnectionRef.current = pc

      pc.onconnectionstatechange = () => {
        setConnectionState(pc.connectionState)
        console.log('RTCPeerConnection state:', pc.connectionState)
      }
      pc.oniceconnectionstatechange = () => {
        setIceState(pc.iceConnectionState)
        console.log('ICE state:', pc.iceConnectionState)
      }
      pc.onicecandidate = (e) => {
        if (e.candidate) console.log('ICE candidate:', e.candidate.candidate)
      }

      // prepare receiving tracks
      pc.addTransceiver('video', { direction: 'recvonly' })
      // If audio is problematic in your env, comment the next line out:
      pc.addTransceiver('audio', { direction: 'recvonly' })

      pc.ontrack = (event) => {
        const stream = event.streams?.[0]
        console.log('ontrack:', event.track.kind, event.track.readyState)
        if (stream) {
          remoteStreamRef.current = stream
        } else if (event.track) {
          if (!remoteStreamRef.current) remoteStreamRef.current = new MediaStream()
          remoteStreamRef.current.addTrack(event.track)
        }
        // Attach if video is ready
        if (videoRef.current && remoteStreamRef.current) {
          videoRef.current.srcObject = remoteStreamRef.current
          videoRef.current.play().catch((e) => console.warn('play() failed:', e))
        }
      }

      // Create & set local offer
      const offer = await pc.createOffer()
      await pc.setLocalDescription(offer)

      // Wait for ICE candidates (WHEP non-trickle)
      await waitForIceGatheringComplete(pc)
      const localSdp = pc.localDescription?.sdp ?? offer.sdp

      // POST to MediaMTX WHEP
      const url = buildWhepUrl(mediamtxUrl, pathName)
      console.log('WHEP POST:', url)

      const response = await axios.post(url, localSdp, {
        headers: { 'Content-Type': 'application/sdp' },
        timeout: 15000,
      })

      // Set remote description
      const answer = new RTCSessionDescription({ type: 'answer', sdp: response.data })
      await pc.setRemoteDescription(answer)

      console.log('WebRTC established with MediaMTX')
    } catch (err: any) {
      console.error('Error establishing WebRTC:', err)
      const msg =
        (err?.response && (err.response.data?.error || err.response.statusText)) ||
        err?.message ||
        'Failed to establish WebRTC connection'
      setError(msg)
      stopWebRTCConnection()
    } finally {
      setIsConnecting(false)
    }
  }

  // Manage lifecycle based on camera flags
  useEffect(() => {
    const shouldConnect =
      camera.enabled && (camera.status === 'processing' || camera.status === 'CONNECTING')

    if (shouldConnect) {
      startWebRTCConnection()
    } else {
      stopWebRTCConnection()
    }

    return () => {
      stopWebRTCConnection()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camera.id, camera.enabled, camera.status])

  const connectionBadgeColor =
    connectionState === 'connected'
      ? 'text-green-400'
      : connectionState === 'connecting'
      ? 'text-yellow-400'
      : connectionState === 'failed' || connectionState === 'disconnected'
      ? 'text-red-400'
      : 'text-gray-400'

  return (
    <div className="bg-gray-800 rounded-lg overflow-hidden">
      {/* Header */}
      <div className="bg-gray-700 px-4 py-3 border-b border-gray-600">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-lg font-semibold text-white">{camera.name}</h3>
            {camera.location && <p className="text-sm text-gray-400">{camera.location}</p>}
          </div>
          <div className="flex items-center space-x-4">
            <span className={`text-sm ${connectionBadgeColor}`}>● {connectionState}</span>
            <span
              className={`text-sm ${
                camera.status === 'processing' ? 'text-green-400' : 'text-red-400'
              }`}
            >
              {camera.status}
            </span>
            <span className="text-xs text-gray-400">ICE: {iceState}</span>
          </div>
        </div>
      </div>

      {/* Video always mounted */}
      <div className="relative">
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          className="w-full aspect-video bg-black"
          onLoadedMetadata={() => videoRef.current?.play().catch(() => {})}
          onCanPlay={() => console.log('Video can play')}
          onPlay={() => console.log('Video started')}
          onError={(e) => console.error('Video error:', e)}
        />

        {/* Overlays */}
        {!camera.enabled ||
        (camera.status !== 'processing' && camera.status !== 'CONNECTING') ? (
          <div className="absolute inset-0 bg-gray-900/90 flex items-center justify-center">
            <div className="text-center">
              <p className="text-gray-400">
                {!camera.enabled ? 'Camera is not started' : 'Camera is not processing'}
              </p>
              <p className="text-sm text-gray-500 mt-1">Start the camera to begin streaming</p>
            </div>
          </div>
        ) : null}

        {error && (
          <div className="absolute inset-0 bg-black/70 flex items-center justify-center">
            <div className="text-center">
              <p className="text-red-400">{error}</p>
              <button
                onClick={startWebRTCConnection}
                className="mt-3 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded text-sm"
              >
                Retry Connection
              </button>
            </div>
          </div>
        )}

        {isConnecting && (
          <div className="absolute inset-0 bg-black/50 flex items-center justify-center">
            <div className="text-center">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-400 mx-auto mb-2"></div>
              <p className="text-white">Connecting to stream...</p>
            </div>
          </div>
        )}

        {connectionState === 'connected' && (
          <div className="absolute top-4 right-4">
            <div className="bg-green-600 text-white px-2 py-1 rounded text-xs">● LIVE</div>
          </div>
        )}
      </div>

      {/* Controls */}
      <div className="p-4 bg-gray-700">
        <div className="flex items-center justify-between">
          <div className="text-sm text-gray-400">
            {camera.enabled ? 'Stream active' : 'Stream inactive'}
          </div>
          <div className="flex space-x-2">
            {connectionState === 'connected' && (
              <button
                onClick={stopWebRTCConnection}
                className="bg-red-600 hover:bg-red-700 text-white px-3 py-1 rounded text-sm"
              >
                Disconnect
              </button>
            )}
            {/* {(connectionState === 'disconnected' || connectionState === 'failed') &&
              camera.enabled && ( */}
                <button
                  onClick={startWebRTCConnection}
                  disabled={isConnecting}
                  className="bg-blue-600 hover:bg-blue-700 disabled:bg-gray-600 text-white px-3 py-1 rounded text-sm"
                >
                  {isConnecting ? 'Connecting...' : 'Reconnect'}
                </button>
              {/* )} */}
          </div>
        </div>
      </div>
    </div>
  )
}
