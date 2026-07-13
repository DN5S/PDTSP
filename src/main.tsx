import { Component, StrictMode, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

/** Last-resort boundary: a render/effect crash shows a reload hint instead of
 *  silently unmounting to a permanent blank page. */
class AppErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error) {
    return { error }
  }
  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 24, maxWidth: 640, margin: '0 auto' }}>
          <h1>Something went wrong</h1>
          <p>Reload the page. If it keeps happening, clear this site&apos;s storage.</p>
          <pre style={{ whiteSpace: 'pre-wrap', opacity: 0.7 }}>{String(this.state.error)}</pre>
        </div>
      )
    }
    return this.props.children
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </StrictMode>,
)
