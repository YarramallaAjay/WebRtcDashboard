interface HeaderProps {
  totalCameras: number
  activeCameras: number
  totalAlerts: number
}

function Header({ totalCameras, activeCameras, totalAlerts }: HeaderProps) {
  return (
    <header className="bg-gray-800 border-b border-gray-700">
      <div className="container mx-auto px-4 py-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold text-white">WebRTC Camera Dashboard</h1>
            <p className="text-gray-400 mt-1">Real-time camera monitoring and WebRTC streaming</p>
          </div>

          <div className="flex space-x-6">
            <div className="text-center">
              <div className="text-2xl font-bold text-blue-400">{totalCameras}</div>
              <div className="text-sm text-gray-400">Total Cameras</div>
            </div>

            <div className="text-center">
              <div className="text-2xl font-bold text-green-400">{activeCameras}</div>
              <div className="text-sm text-gray-400">Active Cameras</div>
            </div>

            <div className="text-center">
              <div className="text-2xl font-bold text-red-400">{totalAlerts}</div>
              <div className="text-sm text-gray-400">Total Alerts</div>
            </div>
          </div>
        </div>
      </div>
    </header>
  )
}

export default Header