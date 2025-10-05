import { useEffect, useState } from 'react'
import axios from 'axios'
import CameraTile from './CameraTile'

interface CameraStream {
  id: string
  name: string
  location?: string
  status: string
  pathName: string
  webrtcUrl: string
  enabled: boolean
  uptime?: string
  framesProcessed?: number
}

interface CameraGridProps {
  apiBaseUrl: string
  mediamtxUrl: string
  refreshInterval?: number
}

export default function CameraGrid({
  apiBaseUrl,
  mediamtxUrl,
  refreshInterval = 100000,
}: CameraGridProps) {
  const [streams, setStreams] = useState<CameraStream[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchActiveStreams = async () => {
    try {
      const response = await axios.get(`${apiBaseUrl}/cameras/streams/active`)
      setStreams(response.data.streams || [])
      setError(null)
    } catch (err: any) {
      console.error('Error fetching streams:', err)
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchActiveStreams()

    const interval = setInterval(fetchActiveStreams, refreshInterval)
    return () => clearInterval(interval)
  }, [apiBaseUrl, refreshInterval])

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-gray-400">Loading camera streams...</div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="bg-red-600/20 border border-red-600 rounded-lg p-4">
        <p className="text-red-400">Error loading streams: {error}</p>
        <button
          onClick={fetchActiveStreams}
          className="mt-2 bg-red-600 hover:bg-red-700 text-white px-3 py-1 rounded text-sm"
        >
          Retry
        </button>
      </div>
    )
  }

  if (streams.length === 0) {
    return (
      <div className="bg-gray-800 rounded-lg p-8 text-center">
        <h3 className="text-xl font-semibold mb-2">No Active Streams</h3>
        <p className="text-gray-400 mb-4">
          Start cameras from the camera list to view live streams
        </p>
        <button
          onClick={fetchActiveStreams}
          className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded"
        >
          Refresh
        </button>
      </div>
    )
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-2xl font-bold">Live Camera Feeds</h2>
        <div className="text-sm text-gray-400">
          {streams.length} active {streams.length === 1 ? 'stream' : 'streams'}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-2 xl:grid-cols-4 gap-4">
        {streams.map((stream) => (
          <CameraTile
            key={stream.id}
            camera={stream}
            mediamtxUrl={mediamtxUrl}
            apiBaseUrl={apiBaseUrl}
          />
        ))}
      </div>
    </div>
  )
}