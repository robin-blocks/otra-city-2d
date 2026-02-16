import type { ResidentState, VisibleResident, InventoryItem } from './resident.js';

// === Server -> Client/Agent messages ===

export interface PerceptionUpdate {
  tick: number;
  time: string;  // ISO timestamp
  world_time: number;  // game time in seconds (use with TIME_SCALE to derive hour/minute)
  self: {
    id: string;
    passport_no: string;
    x: number;
    y: number;
    facing: number;
    hunger: number;
    thirst: number;
    energy: number;
    bladder: number;
    health: number;
    wallet: number;
    inventory: InventoryItem[];
    status: string;
    is_sleeping: boolean;
    current_building: string | null;
    employment: { job: string; on_shift: boolean } | null;
  };
  visible: VisibleEntity[];
  audible: AudibleMessage[];
  interactions: string[];
  notifications: string[];
}

export type VisibleEntity =
  | VisibleResident
  | VisibleBuilding
  | VisibleObject;

export interface VisibleBuilding {
  id: string;
  type: 'building';
  name: string;
  building_type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  door_x: number;
  door_y: number;
}

export interface VisibleObject {
  id: string;
  type: 'object';
  object_type: string;  // 'tree', 'bench', 'headstone', 'body', etc.
  x: number;
  y: number;
}

export interface AudibleMessage {
  from: string;
  from_name: string;
  text: string;
  volume: 'whisper' | 'normal' | 'shout';
  distance: number;
}

export interface InspectData {
  id: string;
  passport_no: string;
  full_name: string;
  preferred_name: string;
  place_of_origin: string;
  type: 'AGENT' | 'HUMAN';
  status: string;
  date_of_arrival: string;
  wallet: number;
  recent_events: Array<{
    timestamp: number;
    type: string;
    data: Record<string, unknown>;
  }>;
}

export type ServerMessage =
  | { type: 'perception'; data: PerceptionUpdate }
  | { type: 'action_result'; request_id: string; status: 'ok' | 'error'; reason?: string; data?: Record<string, unknown> }
  | { type: 'welcome'; resident: ResidentState; map_url: string; world_time: number }
  | { type: 'inspect_result'; request_id: string; data: InspectData }
  | { type: 'train_arriving'; eta_seconds: number }
  | { type: 'spawn'; resident: ResidentState }
  | { type: 'death'; resident_id: string; cause: string }
  | { type: 'event'; event_type: string; data: Record<string, unknown> }
  | { type: 'error'; code: string; message: string };

// === Client/Agent -> Server messages ===

export type ClientMessage =
  | { type: 'auth'; token: string }
  | { type: 'move'; params: { direction: number; speed: 'walk' | 'run' }; request_id?: string }
  | { type: 'move_to'; params: { target: string } | { x: number; y: number }; request_id?: string }
  | { type: 'stop'; request_id?: string }
  | { type: 'face'; params: { direction: number }; request_id?: string }
  | { type: 'speak'; params: { text: string; volume: 'whisper' | 'normal' | 'shout' }; request_id?: string }
  | { type: 'eat'; params: { item_id: string }; request_id?: string }
  | { type: 'drink'; params: { item_id: string }; request_id?: string }
  | { type: 'sleep'; request_id?: string }
  | { type: 'wake'; request_id?: string }
  | { type: 'use_toilet'; request_id?: string }
  | { type: 'enter_building'; params: { building_id: string }; request_id?: string }
  | { type: 'exit_building'; request_id?: string }
  | { type: 'buy'; params: { item_type: string; quantity: number }; request_id?: string }
  | { type: 'collect_ubi'; request_id?: string }
  | { type: 'inspect'; params: { target_id: string }; request_id?: string }
  | { type: 'trade'; params: { target_id: string; offer_quid: number; request_quid: number }; request_id?: string }
  | { type: 'apply_job'; params: { job_id: string }; request_id?: string }
  | { type: 'quit_job'; request_id?: string }
  | { type: 'write_petition'; params: { category: string; description: string }; request_id?: string }
  | { type: 'vote_petition'; params: { petition_id: string }; request_id?: string }
  | { type: 'collect_body'; params: { body_id: string }; request_id?: string }
  | { type: 'process_body'; request_id?: string }
  | { type: 'depart'; request_id?: string }
  | { type: 'list_jobs'; request_id?: string }
  | { type: 'list_petitions'; request_id?: string };

// === Registration ===

export interface PassportRegistration {
  full_name: string;
  preferred_name: string;
  date_of_birth?: string;
  place_of_origin: string;
  type: 'AGENT' | 'HUMAN';
  agent_framework?: string;
  webhook_url?: string;
  height_cm?: number;
  build?: string;
  hair_style?: number;
  hair_color?: number;
  eye_color?: number;
  skin_tone?: number;
  distinguishing_feature?: string;
}

export interface PassportResponse {
  passport: {
    passport_no: string;
    full_name: string;
    preferred_name: string;
  };
  token: string;
  message: string;
}
