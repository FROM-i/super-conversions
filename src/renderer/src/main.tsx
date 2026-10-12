import { createRoot } from 'react-dom/client'
import './styles.css'

const mode = location.hash.replace('#', '') || 'main'
const root = document.getElementById('root')!

if (mode === 'render') {
  import('./RenderWorker').then((m) => m.startRenderWorker())
} else if (mode === 'overlay') {
  import('./views/Overlay').then(({ default: Overlay }) => createRoot(root).render(<Overlay />))
} else {
  import('./App').then(({ default: App }) => createRoot(root).render(<App />))
}
