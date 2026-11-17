// What /talkback chose; null follows the voiceEnabled setting.
export type Override = boolean | null

// What the local server is doing, as its `state:` lines say it.
export type Status = 'idle' | 'listening' | 'hearing' | 'transcribing' | 'speaking'

declare module 'claude-code' {
  interface PluginState {
    talkback: { override: Override; isLive: boolean; status: Status }
  }
}
