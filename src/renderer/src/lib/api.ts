import type { ScApi } from '../../../preload'
declare global {
  interface Window {
    sc: ScApi
  }
}
export const sc = window.sc
