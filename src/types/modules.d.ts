declare module 'heic-decode' {
  const decode: (o: { buffer: Buffer | Uint8Array }) => Promise<{ width: number; height: number; data: Uint8ClampedArray }>
  export default decode
}
declare module 'font-list' {
  export function getFonts(o?: { disableQuoting?: boolean }): Promise<string[]>
}
declare module '*?url' {
  const url: string
  export default url
}
