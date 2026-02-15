import { Container, Graphics, Text, TextStyle, Rectangle } from 'pixi.js';
import type { VisibleResident } from '@otra/shared';

// Skin tone palette
const SKIN_TONES = [0xfde0c0, 0xf5c89a, 0xe0a873, 0xc68642, 0x8d5524, 0x6b3a1f, 0x4a2511, 0x2d1507];
// Hair color palette
const HAIR_COLORS = [0x2c1b0e, 0x4a3728, 0x8b6914, 0xd4a04a, 0xc44a1a, 0x1a1a1a, 0x888888, 0xf0e0c0];

const FADE_DURATION = 1000; // ms to fade out when leaving perception

interface RenderedResident {
  container: Container;
  body: Graphics;
  nameTag: Text;
  targetX: number;
  targetY: number;
  fadeStart: number | null; // timestamp when fade-out began, null = fully visible
}

const nameStyle = new TextStyle({
  fontFamily: 'Courier New',
  fontSize: 10,
  fill: 0xeeeeee,
  align: 'center',
  dropShadow: { color: 0x000000, blur: 2, distance: 1 },
});

export class ResidentRenderer {
  private parent: Container;
  private rendered = new Map<string, RenderedResident>();
  onResidentClick: ((residentId: string) => void) | null = null;

  constructor(parent: Container) {
    this.parent = parent;
  }

  /** Update visible residents from perception data */
  updateResidents(
    visible: VisibleResident[],
    selfId: string,
    selfName: string,
    selfX: number,
    selfY: number,
    selfFacing: number,
    selfAction: string,
    selfSkinTone: number,
    selfHairColor: number,
  ): void {
    const activeIds = new Set<string>();

    // Render self — snap directly to predicted position (no lerp needed)
    activeIds.add(selfId);
    this.renderResident(selfId, selfName, selfX, selfY, selfFacing, selfAction,
      selfSkinTone, 0, selfHairColor, false, true);

    // Render visible others — set target, interpolate smoothly
    for (const r of visible) {
      if (r.type !== 'resident') continue;
      activeIds.add(r.id);
      this.renderResident(
        r.id, r.name, r.x, r.y, r.facing, r.action,
        r.appearance.skin_tone, r.appearance.hair_style, r.appearance.hair_color,
        r.is_dead, false,
      );
    }

    // Interpolate other residents toward their target positions
    for (const [id, rr] of this.rendered) {
      if (id === selfId) continue;
      rr.container.x += (rr.targetX - rr.container.x) * 0.25;
      rr.container.y += (rr.targetY - rr.container.y) * 0.25;
      rr.container.zIndex = Math.floor(rr.container.y);
    }

    const now = Date.now();

    // Handle residents no longer in the visible set
    for (const [id, rr] of this.rendered) {
      if (activeIds.has(id)) {
        // Still visible — cancel any ongoing fade, restore full opacity
        if (rr.fadeStart !== null) {
          rr.fadeStart = null;
          rr.container.alpha = 1;
        }
      } else {
        // Not visible — start fading or continue fading
        if (rr.fadeStart === null) {
          rr.fadeStart = now;
        }
        const elapsed = now - rr.fadeStart;
        if (elapsed >= FADE_DURATION) {
          // Fully faded — remove
          this.parent.removeChild(rr.container);
          rr.container.destroy({ children: true });
          this.rendered.delete(id);
        } else {
          rr.container.alpha = 1 - elapsed / FADE_DURATION;
        }
      }
    }
  }

  private renderResident(
    id: string, name: string, x: number, y: number,
    facing: number, action: string,
    skinTone: number, hairStyle: number, hairColor: number,
    isDead: boolean, snap: boolean,
  ): void {
    let rr = this.rendered.get(id);

    if (!rr) {
      const container = new Container();
      const body = new Graphics();
      const nameTag = new Text({ text: name, style: nameStyle });
      nameTag.anchor.set(0.5, 1);
      nameTag.y = -20;
      container.addChild(body);
      container.addChild(nameTag);
      this.parent.addChild(container);
      // Make clickable
      container.eventMode = 'static';
      container.cursor = 'pointer';
      container.hitArea = new Rectangle(-12, -20, 24, 36);
      container.on('pointerdown', () => {
        this.onResidentClick?.(id);
      });
      // New residents snap to their initial position
      container.x = x;
      container.y = y;
      rr = { container, body, nameTag, targetX: x, targetY: y, fadeStart: null };
      this.rendered.set(id, rr);
    }

    // Update target position
    rr.targetX = x;
    rr.targetY = y;

    // Self snaps directly to predicted position; others interpolate in updateResidents
    if (snap) {
      rr.container.x = x;
      rr.container.y = y;
      rr.container.zIndex = Math.floor(y);
    }

    // Redraw body
    rr.body.clear();

    const skin = SKIN_TONES[skinTone % SKIN_TONES.length];
    const hair = HAIR_COLORS[hairColor % HAIR_COLORS.length];

    if (isDead) {
      // Dead: X marker
      rr.body.moveTo(-8, -8);
      rr.body.lineTo(8, 8);
      rr.body.moveTo(8, -8);
      rr.body.lineTo(-8, 8);
      rr.body.stroke({ width: 3, color: 0xcc0000 });
      // Gray body
      rr.body.circle(0, -4, 8);
      rr.body.fill(0x555555);
    } else if (action === 'sleeping') {
      // Sleeping: lying down oval
      rr.body.ellipse(0, 0, 12, 6);
      rr.body.fill(skin);
      // Zzz
      rr.nameTag.text = `${name} 💤`;
    } else {
      // Normal: head circle + body rectangle
      // Body
      rr.body.rect(-6, -2, 12, 14);
      rr.body.fill(0x3355aa); // clothing color

      // Head
      rr.body.circle(0, -8, 7);
      rr.body.fill(skin);

      // Hair
      rr.body.arc(0, -8, 7, -Math.PI, 0);
      rr.body.fill(hair);

      // Facing indicator (small triangle)
      const fRad = (facing * Math.PI) / 180;
      const fx = Math.cos(fRad) * 14;
      const fy = Math.sin(fRad) * 14;
      rr.body.circle(fx, fy - 4, 2);
      rr.body.fill(0xffffff);

      rr.nameTag.text = name;
    }
  }
}
