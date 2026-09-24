declare global {
  interface Window {
    process: {
      env: {
        NODE_ENV: string
      }
    }
  }
}
export {}
