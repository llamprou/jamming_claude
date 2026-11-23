/** Web MIDI input. */

export async function startMidi(onNote: (kind: 'on' | 'off', pitch: number, velocity: number) => void, onDevices: (names: string[]) => void): Promise<void> {
  const access = await navigator.requestMIDIAccess()
  // Rebinding on every state change means a keyboard plugged in mid-session just works.
  const bind = () => {
    const names: string[] = []
    for (const input of access.inputs.values()) {
      names.push(input.name ?? 'MIDI input')
      input.onmidimessage = (event) => {
        const [status = 0, pitch = 0, velocity = 0] = event.data ?? []
        const command = status & 0xf0
        if (command === 0x90 && velocity > 0) onNote('on', pitch, velocity / 127)
        else if (command === 0x80 || command === 0x90) onNote('off', pitch, 0)
      }
    }
    onDevices(names)
  }
  bind()
  access.onstatechange = bind
}
