export type KernelStatus =
  'stopped' | 'starting' | 'running' | 'stopping' | 'errored'

export interface KernelState {
  status: KernelStatus
  pid?: number
  startedAt?: number // uptimeMs = Date.now() - startedAt
  version?: string // captured from Clash GET /version once ready
  externalController: string // loopback Clash API address used by the supervisor
  secret: string // Clash API secret (also written into config)
  lastExitCode?: number | null
  lastError?: string
}

export interface SupervisorOptions {
  binaryPath: string // resolved mihomo (.exe on win)
  homeDir: string // mihomo -d working dir (writable)
  activeConfigPath: string // mihomo -f target managed by the gateway
  startTimeoutMs?: number // default 10_000
  stopTimeoutMs?: number // default 5_000
  validateTimeoutMs?: number // default 300_000; first validation may download GEO data
  autoRestart?: boolean // crash watchdog; default true
  maxRestarts?: number // consecutive auto-restarts before giving up; default 3
  restartBackoffMs?: number // delay before each auto-restart; default 1_000
  stableRestartMs?: number // running this long resets the crash counter; default 30_000
  // Managed overlays (the fixed SOCKS gateway) are applied immediately before
  // every spawn, after reading the active config.
  configTransform?: (content: string) => string | Promise<string>
}

export interface KernelLogLine {
  stream: 'stdout' | 'stderr'
  line: string
  ts: number
}

export interface MihomoSupervisor {
  getState: () => KernelState
  start: () => Promise<KernelState>
  stop: () => Promise<KernelState>
  restart: () => Promise<KernelState>
  setBinaryPath: (path: string) => void // takes effect on the NEXT start/validate
  validate: (configPath: string) => Promise<{ valid: boolean; message: string }>
  on: ((event: 'log', cb: (l: KernelLogLine) => void) => void) &
    ((event: 'state', cb: (s: KernelState) => void) => void)
  // Unregister a callback previously passed to on().
  off: ((event: 'log', cb: (l: KernelLogLine) => void) => void) &
    ((event: 'state', cb: (s: KernelState) => void) => void)
  dispose: () => Promise<void>
}
