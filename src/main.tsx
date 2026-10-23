import { Component, StrictMode, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'

/**
 * Last-resort boundary.
 *
 * Without it, any throw during the first render leaves an empty `#root` and the
 * page looks like it simply did not load — which is impossible to report
 * accurately ("点开是白屏" is all you get). Showing the message at least names
 * the failure and offers a way back to a clean state.
 */
class CrashGuard extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <div className="crash">
        <h1>Pathcraft 启动失败</h1>
        <p>Something threw before the workbench could mount.</p>
        <pre>{error.message}</pre>
        <div className="crash-actions">
          <button
            type="button"
            onClick={() => {
              // A malformed share link is the usual culprit: drop it and reload.
              window.location.hash = ''
              window.location.reload()
            }}
          >
            清除链接状态并重载
          </button>
        </div>
      </div>
    )
  }
}

const container = document.getElementById('root')

if (container) {
  createRoot(container).render(
    <StrictMode>
      <CrashGuard>
        <App />
      </CrashGuard>
    </StrictMode>,
  )
}
