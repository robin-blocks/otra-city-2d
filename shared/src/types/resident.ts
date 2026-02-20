export type ResidentType = 'AGENT' | 'HUMAN';
export type ResidentStatus = 'ALIVE' | 'DECEASED' | 'DEPARTED';
export type Build = 'Slim' | 'Medium' | 'Athletic' | 'Heavy';

export interface Passport {
  passport_no: string;          // OC-XXXXXXX
  full_name: string;
  preferred_name: string;
  date_of_birth: string;        // ISO date
  place_of_origin: string;
  date_of_arrival: string;      // ISO datetime
  type: ResidentType;
  status: ResidentStatus;
  height_cm: number;
  build: Build;
  hair_style: number;           // index into preset list
  hair_color: number;           // index into palette
  eye_color: number;            // index into palette
  skin_tone: number;            // index into palette
  distinguishing_feature: string;
}

export interface Needs {
  hunger: number;     // 100 = full, 0 = starving
  thirst: number;     // 100 = hydrated, 0 = dehydrated
  energy: number;     // 100 = rested, 0 = exhausted
  bladder: number;    // 0 = empty, 100 = desperate
  health: number;     // 100 = healthy, 0 = dead
  social: number;     // 100 = socially fulfilled, 0 = isolated
}

export interface InventoryItem {
  id: string;
  type: string;
  quantity: number;
}

export interface ResidentState {
  id: string;
  passport: Passport;
  x: number;
  y: number;
  facing: number;               // degrees 0-359
  needs: Needs;
  wallet: number;
  inventory: InventoryItem[];
  status: 'idle' | 'walking' | 'sleeping' | 'working' | 'dead';
  is_sleeping: boolean;
  is_dead: boolean;
  current_building: string | null;
  employment: { job: string; on_shift: boolean } | null;
  agent_framework?: string;
}

export interface VisibleResident {
  id: string;
  type: 'resident';
  name: string;
  x: number;
  y: number;
  facing: number;
  appearance: {
    skin_tone: number;
    hair_style: number;
    hair_color: number;
    build: Build;
  };
  action: string;   // idle, walking, sleeping, working, dead
  is_dead: boolean;
  agent_framework?: string;
  condition?: 'healthy' | 'struggling' | 'critical';
  is_wanted?: boolean;       // currently breaking a law
  is_police?: boolean;       // employed as police officer
  is_arrested?: boolean;     // arrested or imprisoned
}
