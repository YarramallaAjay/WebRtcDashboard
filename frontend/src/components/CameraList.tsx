import { useState } from 'react'

interface Camera {
  id: string
  name: string
  rtspUrl: string
  location?: string
  enabled: boolean
  status: string
  createdAt: string
  _count?: {
    alerts: number
  }
}

interface CameraListProps {
  cameras: Camera[]
  onCameraSelect: (camera: Camera) => void
  onCameraStart: (camera: Camera) => void
  onCameraStop: (cameraId: string) => void
  onCameraCreate: (cameraData: { name: string; rtspUrl: string; location?: string }) => void
  selectedCamera: Camera | null
}

function CameraList({
  cameras,
  onCameraSelect,
  onCameraStart,
  onCameraStop,
  onCameraCreate,
  selectedCamera,
}: CameraListProps) {
  const [showAddForm, setShowAddForm] = useState(false)
  const [formData, setFormData] = useState({
    name: '',
    rtspUrl: '',
    location: '',
  })

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    console.log('Form submitted with data:', formData)

    if (!formData.name || !formData.rtspUrl) {
      console.log('Form validation failed:', { name: formData.name, rtspUrl: formData.rtspUrl })
      return
    }

    console.log('Calling onCameraCreate with:', {
      name: formData.name,
      rtspUrl: formData.rtspUrl,
      location: formData.location || undefined,
    })

    onCameraCreate({
      name: formData.name,
      rtspUrl: formData.rtspUrl,
      location: formData.location || undefined,
    })

    setFormData({ name: '', rtspUrl: '', location: '' })
    setShowAddForm(false)
  }

  const getStatusColor = (status: string) => {
    switch (status.toLowerCase()) {
      case 'online':
      case 'processing':
        return 'text-green-400'
      case 'offline':
        return 'text-red-400'
      default:
        return 'text-yellow-400'
    }
  }

  return (
    <div className="bg-gray-800 rounded-lg p-6">
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl font-semibold text-white">Cameras</h2>
        <button
          onClick={() => setShowAddForm(!showAddForm)}
          className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg text-sm"
        >
          + Add Camera
        </button>
      </div>

      {showAddForm && (
        <form onSubmit={handleSubmit} className="mb-6 p-4 bg-gray-700 rounded-lg">
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-1">
                Camera Name
              </label>
              <input
                type="text"
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                className="w-full p-2 bg-gray-600 border border-gray-500 rounded text-white"
                placeholder="e.g., Front Door Camera"
                required
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-1">
                RTSP URL
              </label>
              <input
                type="url"
                value={formData.rtspUrl}
                onChange={(e) => setFormData({ ...formData, rtspUrl: e.target.value })}
                className="w-full p-2 bg-gray-600 border border-gray-500 rounded text-white"
                placeholder="rtsp://camera-ip:554/stream"
                required
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-1">
                Location (Optional)
              </label>
              <input
                type="text"
                value={formData.location}
                onChange={(e) => setFormData({ ...formData, location: e.target.value })}
                className="w-full p-2 bg-gray-600 border border-gray-500 rounded text-white"
                placeholder="e.g., Main Entrance"
              />
            </div>
            <div className="flex space-x-2">
              <button
                type="submit"
                className="bg-green-600 hover:bg-green-700 text-white px-4 py-2 rounded text-sm"
              >
                Add Camera
              </button>
              <button
                type="button"
                onClick={() => setShowAddForm(false)}
                className="bg-gray-600 hover:bg-gray-700 text-white px-4 py-2 rounded text-sm"
              >
                Cancel
              </button>
            </div>
          </div>
        </form>
      )}

      <div className="space-y-3">
        {cameras.length === 0 ? (
          <div className="text-center py-8 text-gray-400">
            <p>No cameras configured</p>
            <p className="text-sm">Click "Add Camera" to get started</p>
          </div>
        ) : (
          cameras.map((camera) => (
            <div
              key={camera.id}
              className={`p-4 rounded-lg border cursor-pointer transition-all ${
                selectedCamera?.id === camera.id
                  ? 'border-blue-500 bg-gray-700'
                  : 'border-gray-600 bg-gray-750 hover:border-gray-500'
              }`}
              onClick={() => onCameraSelect(camera)}
            >
              <div className="flex items-center justify-between">
                <div className="flex-1">
                  <h3 className="font-medium text-white">{camera.name}</h3>
                  {camera.location && (
                    <p className="text-sm text-gray-400 mt-1">{camera.location}</p>
                  )}
                  <div className="flex items-center mt-2 space-x-4">
                    <span className={`text-sm ${getStatusColor(camera.status)}`}>
                      ● {camera.status}
                    </span>
                    {camera._count?.alerts && camera._count.alerts > 0 && (
                      <span className="text-sm text-red-400">
                        {camera._count.alerts} alerts
                      </span>
                    )}
                  </div>
                </div>

                <div className="flex flex-col space-y-2">
                  {camera.enabled ? (
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        onCameraStop(camera.id)
                      }}
                      className="bg-red-600 hover:bg-red-700 text-white px-3 py-1 rounded text-sm"
                    >
                      Stop
                    </button>
                  ) : (
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        onCameraStart(camera)
                      }}
                      className="bg-green-600 hover:bg-green-700 text-white px-3 py-1 rounded text-sm"
                    >
                      Start
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  )
}

export default CameraList