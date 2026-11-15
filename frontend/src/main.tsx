import { Component, StrictMode, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import 'maplibre-gl/dist/maplibre-gl.css'
import { setWorkerUrl } from 'maplibre-gl'
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url'
import './index.css'
import App from './App.tsx'

setWorkerUrl(workerUrl) // Vite doesn't copy MapLibre's worker on its own

/** Last line of defence: a render crash shows what failed and a way back, never a blank page. */
class AppBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error) { return { error } }
  render() {
    const e = this.state.error
    if (!e) return this.props.children
    return (
      <div className="h-full grid place-items-center p-6">
        <div role="alert" className="max-w-[560px] bg-panel border border-accent/60 rounded-md p-6 flex flex-col gap-4">
          <h1 className="text-lg font-semibold text-ink">Hots45 hit an error and stopped</h1>
          <p className="text-sm text-dim">Reloading usually fixes it. If it keeps happening, the message below helps us find the cause.</p>
          <pre className="num text-xs text-dim whitespace-pre-wrap break-words max-h-[240px] overflow-auto" data-app-error>{e.message}{'\n'}{e.stack?.split('\n').slice(0, 6).join('\n')}</pre>
          <button className="self-start h-8 px-3 rounded-md bg-accent text-bg font-semibold text-sm" onClick={() => location.reload()}>Reload</button>
        </div>
      </div>
    )
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppBoundary><App /></AppBoundary>
  </StrictMode>,
)
