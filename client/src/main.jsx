/**
 * @file Application entrypoint. Mounts <App /> into #root under StrictMode.
 *
 * Note: StrictMode double-invokes effects in dev, so useSocket() connects,
 * disconnects and reconnects once on mount — harmless with Socket.IO's
 * auto-reconnect, but worth knowing when reading connection logs.
 */

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
