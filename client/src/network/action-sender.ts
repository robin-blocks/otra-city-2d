import type { WsClient } from './ws-client.js';

let requestCounter = 0;

function nextRequestId(): string {
  return `req_${++requestCounter}`;
}

export class ActionSender {
  constructor(private ws: WsClient) {}

  move(direction: number, speed: 'walk' | 'run' = 'walk'): void {
    this.ws.send({
      type: 'move',
      params: { direction, speed },
      request_id: nextRequestId(),
    });
  }

  stop(): void {
    this.ws.send({
      type: 'stop',
      request_id: nextRequestId(),
    });
  }

  face(direction: number): void {
    this.ws.send({
      type: 'face',
      params: { direction },
      request_id: nextRequestId(),
    });
  }

  speak(text: string, volume: 'whisper' | 'normal' | 'shout' = 'normal'): void {
    this.ws.send({
      type: 'speak',
      params: { text, volume },
      request_id: nextRequestId(),
    });
  }

  sleep(): void {
    this.ws.send({ type: 'sleep', request_id: nextRequestId() });
  }

  wake(): void {
    this.ws.send({ type: 'wake', request_id: nextRequestId() });
  }

  enterBuilding(buildingId: string): void {
    this.ws.send({
      type: 'enter_building',
      params: { building_id: buildingId },
      request_id: nextRequestId(),
    });
  }

  exitBuilding(): void {
    this.ws.send({ type: 'exit_building', request_id: nextRequestId() });
  }

  buy(itemType: string, quantity: number = 1): void {
    this.ws.send({
      type: 'buy',
      params: { item_type: itemType, quantity },
      request_id: nextRequestId(),
    });
  }

  collectUbi(): void {
    this.ws.send({ type: 'collect_ubi', request_id: nextRequestId() });
  }

  useToilet(): void {
    this.ws.send({ type: 'use_toilet', request_id: nextRequestId() });
  }

  eat(itemId: string): void {
    this.ws.send({
      type: 'eat',
      params: { item_id: itemId },
      request_id: nextRequestId(),
    });
  }

  drink(itemId: string): void {
    this.ws.send({
      type: 'drink',
      params: { item_id: itemId },
      request_id: nextRequestId(),
    });
  }

  inspect(targetId: string): void {
    this.ws.send({
      type: 'inspect',
      params: { target_id: targetId },
      request_id: nextRequestId(),
    });
  }
}
