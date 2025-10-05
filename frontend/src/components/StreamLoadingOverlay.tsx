import { useEffect, useState } from 'react'

interface StreamLoadingOverlayProps {
  status: string
  isPolling?: boolean
  elapsedTime?: number
}

export default function StreamLoadingOverlay({
  status,
  isPolling = false,
  elapsedTime = 0,
}: StreamLoadingOverlayProps) {
  const [dots, setDots] = useState('.')

  useEffect(() => {
    const interval = setInterval(() => {
      setDots((prev) => (prev.length >= 3 ? '.' : prev + '.'))
    }, 500)

    return () => clearInterval(interval)
  }, [])

  const getMessage = () => {
    switch (status) {
      case 'CONNECTING':
        return 'Establishing stream connection'
      case 'PROCESSING':
        return 'Processing video stream'
      case 'OFFLINE':
        return 'Starting camera'
      case 'ERROR':
        return 'Connection error - retrying'
      default:
        return 'Loading stream'
    }
  }

  return (
    <div className="absolute inset-0 bg-gradient-to-br from-gray-900 to-gray-800 flex flex-col items-center justify-center">
      {/* Animated spinner */}
      <div className="relative">
        <div className="animate-spin rounded-full h-16 w-16 border-t-2 border-b-2 border-blue-500"></div>
        <div className="absolute inset-0 animate-ping rounded-full h-16 w-16 border border-blue-400 opacity-30"></div>
      </div>

      {/* Status message */}
      <div className="mt-6 text-center">
        <p className="text-white font-semibold text-lg">
          {getMessage()}
          <span className="inline-block w-8 text-left">{dots}</span>
        </p>

        {isPolling && (
          <p className="text-gray-400 text-sm mt-2">
            Checking stream status ({Math.floor(elapsedTime / 1000)}s)
          </p>
        )}

        {elapsedTime > 10000 && (
          <p className="text-yellow-400 text-xs mt-2">
            Stream is taking longer than usual to establish
          </p>
        )}
      </div>

      {/* Progress bar */}
      <div className="mt-4 w-48 h-1 bg-gray-700 rounded-full overflow-hidden">
        <div className="h-full bg-blue-500 animate-pulse" style={{ width: '60%' }}></div>
      </div>

      {/* Steps indicator */}
      <div className="mt-6 flex items-center gap-2 text-xs text-gray-400">
        <div className={`flex items-center gap-1 ${status === 'CONNECTING' ? 'text-blue-400' : 'text-gray-500'}`}>
          <div className={`w-2 h-2 rounded-full ${status === 'CONNECTING' ? 'bg-blue-400 animate-pulse' : 'bg-gray-600'}`}></div>
          <span>Connecting</span>
        </div>
        <div className="w-4 h-px bg-gray-600"></div>
        <div className={`flex items-center gap-1 ${status === 'PROCESSING' ? 'text-blue-400' : 'text-gray-500'}`}>
          <div className={`w-2 h-2 rounded-full ${status === 'PROCESSING' ? 'bg-blue-400 animate-pulse' : 'bg-gray-600'}`}></div>
          <span>Processing</span>
        </div>
        <div className="w-4 h-px bg-gray-600"></div>
        <div className={`flex items-center gap-1 text-gray-500`}>
          <div className="w-2 h-2 rounded-full bg-gray-600"></div>
          <span>Ready</span>
        </div>
      </div>
    </div>
  )
}
