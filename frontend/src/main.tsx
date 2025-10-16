import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { StartupCheck } from './components/StartupCheck'

createRoot(document.getElementById('root')!).render(
    <StartupCheck>
        <App />
    </StartupCheck>
)
