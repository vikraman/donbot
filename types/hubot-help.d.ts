declare module 'hubot-help' {
  import type { Robot } from 'hubot'
  const hubotHelp: (robot: Robot) => void | Promise<void>
  export default hubotHelp
}
