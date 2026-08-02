import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import './App.css'
import App from './App.jsx'
import ErrorBoundary from './components/ErrorBoundary.jsx'
import { reportFailure } from './data/netStatus.js'

// Promises rejeitadas fora de um try/catch morriam em silêncio. Aqui elas ao
// menos aparecem no console e, se forem queda de conexão, acendem o banner de
// offline como qualquer outra chamada.
window.addEventListener('unhandledrejection', (e) => {
  console.error('[nimbus] promise rejeitada sem tratamento:', e.reason)
  reportFailure(e.reason)
})
window.addEventListener('error', (e) => {
  console.error('[nimbus] erro não tratado:', e.error || e.message)
})

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
)
