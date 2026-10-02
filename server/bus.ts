import { EventEmitter } from 'node:events';

/** Everything the UI needs to hear about goes through here and out over SSE. */
export type BusMessage =
  | { type: 'task'; task: unknown }
  | { type: 'event'; event: unknown }
  | { type: 'approval'; approval: unknown }
  | { type: 'agents' }
  | { type: 'settings'; settings: unknown }
  | { type: 'files'; taskId?: string }
  | { type: 'library' }
  | { type: 'site'; status: unknown }
  | { type: 'chat'; chatId: string; message?: unknown; busy?: boolean }
  | { type: 'chat_delta'; chatId: string; text: string }
  | { type: 'notify'; notice: unknown }
  | { type: 'usage'; usage: unknown };

const bus = new EventEmitter();
bus.setMaxListeners(100);

export function publish(msg: BusMessage) {
  bus.emit('msg', msg);
}

export function subscribe(fn: (msg: BusMessage) => void) {
  bus.on('msg', fn);
  return () => bus.off('msg', fn);
}
