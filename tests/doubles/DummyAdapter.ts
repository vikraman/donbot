'use strict'
import { Adapter, TextMessage } from 'hubot'
import type { Envelope, Robot, User } from 'hubot'

export class DummyAdapter extends Adapter {
  name: string
  messages: Set<string>

  constructor (robot: Robot) {
    super(robot)
    this.name = 'DummyAdapter'
    this.messages = new Set()
  }

  async send (envelope: Envelope, ...strings: string[]): Promise<void> {
    this.emit('send', envelope, ...strings)
    this.robot.emit('send', envelope, ...strings)
  }

  async reply (envelope: Envelope, ...strings: string[]): Promise<void> {
    this.emit('reply', envelope, ...strings)
    this.robot.emit('reply', envelope, ...strings)
  }

  async topic (envelope: Envelope, ...strings: string[]): Promise<void> {
    this.emit('topic', envelope, ...strings)
    this.robot.emit('topic', envelope, ...strings)
  }

  async play (envelope: Envelope, ...strings: string[]): Promise<void> {
    this.emit('play', envelope, ...strings)
    this.robot.emit('play', envelope, ...strings)
  }

  async run (): Promise<void> {
    // required to get the scripts loaded
    this.emit('connected')
  }

  close (): void {
    this.emit('closed')
  }

  async say (user: User, message: string, room?: string): Promise<void> {
    this.messages.add(message)
    user.room = room
    await this.robot.receive(new TextMessage(user, message))
  }
}

export default {
  async use (robot: Robot): Promise<DummyAdapter> {
    return new DummyAdapter(robot)
  }
}
