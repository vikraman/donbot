declare module 'hubot' {
  export class User {
    id: string
    name: string
    // not core; Roles.ts adds this per-user
    roles?: string[]
    room?: string
    // attached by the discord adapter
    message?: DiscordMessage
  }

  export class TextMessage {
    constructor (user: User, text: string, id?: string | number)
    user: User
    text: string
    // assigned verbatim; the shell adapter passes Date.now(), doubles omit it
    id?: string | number
    room: string
  }

  // deliberately loose; tests only inspect the strings
  export interface Envelope {
    room?: string
    user?: User
    message?: TextMessage
  }

  // base class for the test double; only the used members
  export class Adapter {
    constructor (robot: Robot)
    robot: Robot
    name?: string
    send(envelope: Envelope, ...strings: string[]): Promise<void>
    reply(envelope: Envelope, ...strings: string[]): Promise<void>
    emote(envelope: Envelope, ...strings: string[]): Promise<void>
    topic(envelope: Envelope, ...strings: string[]): Promise<void>
    play(envelope: Envelope, ...strings: string[]): Promise<void>
    run(): void | Promise<void>
    close(): void
    emit(event: string, ...args: unknown[]): boolean
    on(event: string, listener: (...args: unknown[]) => void): this
  }

  // module name or module-shaped object, per Robot's constructor
  export interface AdapterModule {
    use(robot: Robot): Adapter | Promise<Adapter>
  }

  // optional groups are undefined at runtime; only group 0 always exists
  export type MatchArray = Omit<RegExpMatchArray, number> & {
    [index: number]: string | undefined
    0: string
  }

  export class Response {
    message: TextMessage & { user: User & { message?: DiscordMessage } }
    match: MatchArray
    envelope: unknown
    reply(message: string): Promise<void>
    send(message: string): Promise<void>
  }

  export class Brain {
    data: {
      users: Record<string, User>
      _private: Record<string, unknown>
      [key: string]: unknown
    }
    // T is unchecked; redis holds whatever an older build wrote
    get<T = unknown>(key: string): T | undefined
    set(key: string, value: unknown): void
    remove(key: string): void
    userForId(id: string, options?: { name?: string }): User
    usersForFuzzyName(fuzzyName: string): User[]
    on(event: 'connected' | 'loaded' | 'save', listener: (...args: unknown[]) => void): void
    emit(event: string, ...args: unknown[]): boolean
  }

  export interface MiddlewareContext {
    response: Response
  }

  export type Middleware = (context: MiddlewareContext) => boolean | Promise<boolean>

  export class Robot {
    constructor (adapter: string | AdapterModule, httpd?: boolean, name?: string, alias?: string)

    name: string
    alias?: string
    brain: Brain
    commands: { unregister(name: string): void }
    listeners?: readonly unknown[]
    adapter: Adapter & { client?: DiscordClient; [key: string]: unknown }
    router: ExpressLike

    respond(regex: RegExp, callback: (res: Response) => unknown): void
    hear(regex: RegExp, callback: (res: Response) => unknown): void
    receiveMiddleware(middleware: Middleware): void
    messageRoom(room: string, message: string): Promise<void>

    // used by the test harness, not scripts
    loadAdapter(adapter?: string): Promise<void>
    loadFile(path: string, filename: string): Promise<void>
    load(path: string): Promise<void>
    run(): Promise<void>
    shutdown(): void
    receive(message: TextMessage): Promise<void>
    on(event: string, listener: (...args: any[]) => void): void
    emit(event: string, ...args: unknown[]): void
  }

  // scripts only register GET handlers
  interface ExpressLike {
    get(path: string, handler: (req: unknown, res: { send(body: string): void }) => unknown): void
  }

  // loose on purpose: scripts probe defensively and doubles are partial
  export interface DiscordClient {
    // scripts guard typeof client.on before subscribing
    on?: {
      (event: 'messageReactionAdd' | 'messageReactionRemove', listener: (reaction: DiscordReaction, user: DiscordUser) => void): void
      (event: string, listener: (...args: unknown[]) => void): void
    }
    isReady?(): boolean
    user?: { id?: string; tag?: string; username?: string; setActivity?(text: string, opts: { type: number }): void }
    guilds?: { cache?: { size: number } }
    channels?: { cache?: Map<string, Partial<DiscordChannel>> & { size?: number } }
    users?: { cache?: { size: number } }
    ws?: { ping: number; status: number }
    uptime?: number
  }

  export interface DiscordChannel {
    name?: string
    send(content: string): Promise<DiscordMessage>
    messages: { fetch(query: string | { message: string; cache?: boolean }): Promise<DiscordMessage> }
  }

  export interface DiscordMessage {
    id: string
    channelId: string
    channel: DiscordChannel
    content?: string
    author?: { id: string; username?: string }
    reactions: { cache: Map<string, DiscordReaction> }
    react(emoji: string): Promise<DiscordReaction>
  }

  export interface DiscordReaction {
    emoji: { name: string }
    count: number
    partial: boolean
    message: DiscordMessage
    fetch(): Promise<DiscordReaction>
  }

  export interface DiscordUser {
    id: string
    bot: boolean
    username?: string
  }
}

declare module 'sentiment' {
  export interface SentimentResult {
    score: number
    comparative: number
    tokens: string[]
    words: string[]
    positive: string[]
    negative: string[]
  }

  export default class Sentiment {
    analyze(text: string): SentimentResult
  }
}
