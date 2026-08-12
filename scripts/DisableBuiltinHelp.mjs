// Description:
//   Unregisters hubot core's built-in "help" command so it falls through to
//   hubot-help's classic comment-scraped help listing instead. The built-in
//   command uses a rigid --flag argument syntax that doesn't fit this bot's
//   natural-language scripts, and its dispatch runs in receive middleware
//   ahead of the listener chain, so it would otherwise shadow every other
//   help handler unconditionally.
//

export default async (robot) => {
  robot.commands.unregister('help')
}
