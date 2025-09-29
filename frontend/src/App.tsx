import { useState, useEffect } from 'react'
import axios from 'axios'
import Header from './components/Header'
import CameraList from './components/CameraList'
import WebRTCPlayer from './components/WebRTCPlayer'
import './App.css'

// API configuration - Use environment variables with fallbacks
const API_BASE_URL = import.meta.env.VITE_BACKEND_URL ? `${import.meta.env.VITE_BACKEND_URL}/api` : 'http://localhost:3000/api'
const WORKER_BASE_URL = import.meta.env.VITE_WORKER_URL || 'http://localhost:8080'
const MEDIAMTX_BASE_URL = import.meta.env.VITE_MEDIAMTX_URL || 'http://localhost:9997'

// Types
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
  workerInfo?: {
    pathName?: string
    sessionId?: string
  }
}

interface Alert {
  id: string
  cameraId: string
  frameUrl?: string
  detectedAt: string
  metadata?: any
  camera: {
    id: string
    name: string
    location?: string
  }
}

function App() {
  const [cameras, setCameras] = useState<Camera[]>([])
  const [alerts, setAlerts] = useState<Alert[]>([])
  const [selectedCamera, setSelectedCamera] = useState<Camera | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Fetch cameras from backend
  const fetchCameras = async () => {
    try {
      const response = await axios.get(`${API_BASE_URL}/cameras`)
      setCameras(response.data.cameras || [])
    } catch (err) {
      console.error('Error fetching cameras:', err)
      setError('Failed to fetch cameras')
    }
  }

  // Fetch alerts from backend
  // const fetchAlerts = async () => {
  //   try {
  //     const response = await axios.get(`${API_BASE_URL}/alerts`)
  //     setAlerts(response.data.alerts || [])
  //   } catch (err) {
  //     console.error('Error fetching alerts:', err)
  //   }
  // }

  // Create a new camera
  const createCamera = async (cameraData: { name: string; rtspUrl: string; location?: string }) => {
    try {
      console.log('Attempting to create camera:', cameraData)
      const response = await axios.post(`${API_BASE_URL}/cameras`, cameraData, {
        headers: {
          'Content-Type': 'application/json'
        }
      })
      if(response.status===200 || response.status===201){
        console.log('Camera created successfully:', response.data)
      }
      else{
        console.log('Camera not created:', response.data)
        console.log(response.status)


      }
      fetchCameras() // Refresh the list
      setError(null) // Clear any previous errors
    } catch (err: any) {
      console.error('Error creating camera:', err)
      console.error('Error response:', err.response?.data)
      console.error('Error status:', err.response?.status)
      setError(`Failed to create camera: ${err.response?.data?.error || err.message}`)
    }
  }

  // Start camera processing
  const startCamera = async (camera: Camera) => {
    try {
      setError(null) // Clear any previous errors
      console.log('Starting camera:', camera.id)

      const response = await axios.post(`${API_BASE_URL}/cameras/${camera.id}/start`)
      console.log('Camera started successfully:', response.data)

      if (response.data.camera) {
        // Update the selected camera with the latest data and worker info
        const updatedCamera = {
          ...response.data.camera,
          workerInfo: response.data.workerInfo // Pass worker info to frontend
        }
        setSelectedCamera(updatedCamera)
      }

      fetchCameras() // Refresh the list
    } catch (err: any) {
      console.error('Error starting camera:', err)
      let errorMessage = 'Failed to start camera'

      if (err.response?.data?.error) {
        errorMessage = err.response.data.error
      } else if (err.message) {
        errorMessage = `Failed to start camera: ${err.message}`
      }

      setError(errorMessage)
      fetchCameras() // Refresh to get updated status
    }
  }

  // Stop camera processing
  const stopCamera = async (cameraId: string) => {
    try {
      const response = await axios.post(`${API_BASE_URL}/cameras/${cameraId}/stop`)
      console.log('Camera stopped:', response.data)
      fetchCameras() // Refresh the list
    } catch (err) {
      console.error('Error stopping camera:', err)
      setError('Failed to stop camera')
    }
  }

  // Initialize data on component mount
  useEffect(() => {
    const initialize = async () => {
      setLoading(true)
      await Promise.all([fetchCameras()])
      setLoading(false)
    }

    initialize()

    // Set up polling for real-time updates
    const interval = setInterval(() => {
      fetchCameras()
      // fetchAlerts()
    }, 5000) // Poll every 5 seconds

    return () => clearInterval(interval)
  }, [])

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-900 flex items-center justify-center">
        <div className="text-white text-xl">Loading WebRTC Dashboard...</div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gray-900 text-white">
      <Header
        totalCameras={cameras.length}
        activeCameras={cameras.filter(c => c.enabled).length}
        totalAlerts={alerts.length}
      />

      {error && (
        <div className="bg-red-600 text-white p-4 m-4 rounded">
          {error}
          <button
            onClick={() => setError(null)}
            className="ml-4 bg-red-800 px-2 py-1 rounded text-sm"
          >
            ✕
          </button>
        </div>
      )}

      <div className="container mx-auto px-4 py-6">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Camera List Panel */}
          <div className="lg:col-span-1">
            <CameraList
              cameras={cameras}
              onCameraSelect={setSelectedCamera}
              onCameraStart={startCamera}
              onCameraStop={stopCamera}
              onCameraCreate={createCamera}
              selectedCamera={selectedCamera}
            />
          </div>

          {/* Video Player Panel */}
          <div className="lg:col-span-2">
            {selectedCamera ? (
              <WebRTCPlayer
                camera={selectedCamera}
                workerUrl={WORKER_BASE_URL}
                mediamtxUrl={MEDIAMTX_BASE_URL}
              />
            ) : (
              <div className="bg-gray-800 rounded-lg p-8 text-center">
                <h3 className="text-xl font-semibold mb-4">No Camera Selected</h3>
                <p className="text-gray-400">
                  Select a camera from the list to view its feed
                </p>
              </div>
            )}
          </div>
        </div>

        {/* Recent Alerts Section
        {alerts.length > 0 && (
          <div className="mt-8">
            <h2 className="text-2xl font-bold mb-4">Recent Alerts</h2>
            <div className="bg-gray-800 rounded-lg p-6">
              <div className="space-y-4">
                {alerts.slice(0, 5).map((alert) => (
                  <div key={alert.id} className="flex items-center justify-between border-b border-gray-700 pb-2">
                    <div>
                      <span className="font-semibold">{alert.camera.name}</span>
                      <span className="text-gray-400 ml-2">
                        {new Date(alert.detectedAt).toLocaleString()}
                      </span>
                    </div>
                    <div className="text-sm text-gray-400">
                      {alert.camera.location || 'Unknown location'}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )} */}
      </div>
    </div>
  )
}

export default App
 