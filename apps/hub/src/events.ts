import { EventEmitter } from "node:events";

export interface HubEvent {
  id: number;
  type: string;
  at: string;
  data: Record<string, unknown>;
}

/** In-process event bus. The dashboard subscribes over Server-Sent Events. */
export class EventBus {
  private emitter = new EventEmitter();
  private recent: HubEvent[] = [];
  private nextId = 1;

  constructor(private keep = 200) {
    this.emitter.setMaxListeners(100);
  }

  publish(type: string, data: Record<string, unknown>): HubEvent {
    const event: HubEvent = { id: this.nextId++, type, at: new Date().toISOString(), data };
    this.recent.push(event);
    if (this.recent.length > this.keep) this.recent.shift();
    this.emitter.emit("event", event);
    return event;
  }

  subscribe(listener: (event: HubEvent) => void): () => void {
    this.emitter.on("event", listener);
    return () => this.emitter.off("event", listener);
  }

  history(afterId = 0): HubEvent[] {
    return this.recent.filter((e) => e.id > afterId);
  }
}
