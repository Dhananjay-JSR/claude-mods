// What /talkback chose; null follows the voiceEnabled setting.
export type Override = boolean | null

// What the local server is doing, as its `state:` lines say it.
export type Status = 'idle' | 'listening' | 'hearing' | 'transcribing' | 'speaking'

// A model on its way down, as the server's `progress:` lines say it.
export type Download = { label: string; percent: number } | null

declare module 'claude-code' {
  interface PluginState {
    talkback: { override: Override; isLive: boolean; status: Status; download: Download }
  }
}
