export interface Vec2 {
  x: number;
  y: number;
}

export interface SoundEvent {
  speaker_id: string;
  speaker_name: string;
  text: string;
  volume: 'whisper' | 'normal' | 'shout';
  position: Vec2;
  timestamp: number;
}
