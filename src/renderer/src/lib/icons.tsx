// Minimal square-language icon set (1.75px strokes, square caps).
import type { SVGProps } from 'react'
const I = (p: SVGProps<SVGSVGElement>) => <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="square" strokeLinejoin="miter" {...p} />
export const IcGrid = () => (<I><rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" /><rect x="3" y="14" width="7" height="7" /><rect x="14" y="14" width="7" height="7" /></I>)
export const IcDown = () => (<I><path d="M12 3v12M6 9l6 6 6-6M4 20h16" /></I>)
export const IcPdf = () => (<I><path d="M5 3h10l4 4v14H5z" /><path d="M15 3v4h4M8 13h8M8 17h5" /></I>)
export const IcJobs = () => (<I><rect x="3" y="4" width="18" height="4" /><rect x="3" y="10" width="18" height="4" /><rect x="3" y="16" width="11" height="4" /></I>)
export const IcGear = () => (<I><rect x="8" y="8" width="8" height="8" /><path d="M12 2v4M12 18v4M2 12h4M18 12h4M4.9 4.9l2.8 2.8M16.3 16.3l2.8 2.8M4.9 19.1l2.8-2.8M16.3 7.7l2.8-2.8" /></I>)
export const IcFile = () => (<I><path d="M6 3h8l4 4v14H6z" /><path d="M14 3v4h4" /></I>)
export const IcFolder = () => (<I><path d="M3 6h7l2 2h9v11H3z" /></I>)
export const IcLink = () => (<I><path d="M10 14l4-4M8 11l-3 3a3 3 0 004 4l3-3M16 13l3-3a3 3 0 00-4-4l-3 3" /></I>)
export const IcX = () => (<I width="14" height="14"><path d="M6 6l12 12M18 6L6 18" /></I>)
export const IcCheck = () => (<I width="12" height="12" strokeWidth="3"><path d="M5 12l5 5 9-10" /></I>)
export const IcOpen = () => (<I width="16" height="16"><path d="M14 4h6v6M20 4l-9 9M18 14v6H4V6h6" /></I>)
export const IcRot = () => (<I width="13" height="13" strokeWidth="2.2"><path d="M20 12a8 8 0 11-3-6.2M20 4v5h-5" /></I>)
export const IcTrash = () => (<I width="13" height="13" strokeWidth="2.2"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" /></I>)
export const IcPlus = () => (<I width="16" height="16"><path d="M12 5v14M5 12h14" /></I>)
export const IcUndo = () => (<I width="16" height="16"><path d="M9 14L4 9l5-5M4 9h11a5 5 0 010 10h-3" /></I>)
export const IcRedo = () => (<I width="16" height="16"><path d="M15 14l5-5-5-5M20 9H9a5 5 0 000 10h3" /></I>)
