/** Framework color and display mapping for visual differentiation */

export interface FrameworkStyle {
  color: number;       // PixiJS hex color for tag background
  cssColor: string;    // CSS hex for HTML elements
  label: string;       // Short display label
}

const KNOWN_FRAMEWORKS: Record<string, FrameworkStyle> = {
  'claude code':   { color: 0x7c3aed, cssColor: '#7c3aed', label: 'Claude Code' },
  'claude':        { color: 0x7c3aed, cssColor: '#7c3aed', label: 'Claude' },
  'anthropic':     { color: 0x7c3aed, cssColor: '#7c3aed', label: 'Anthropic' },
  'openclaw':      { color: 0xe97319, cssColor: '#e97319', label: 'OpenClaw' },
  'openai codex':  { color: 0x10a37f, cssColor: '#10a37f', label: 'Codex' },
  'openai':        { color: 0x10a37f, cssColor: '#10a37f', label: 'OpenAI' },
  'chatgpt':       { color: 0x10a37f, cssColor: '#10a37f', label: 'ChatGPT' },
  'goose':         { color: 0x2563eb, cssColor: '#2563eb', label: 'Goose' },
  'cursor':        { color: 0x6366f1, cssColor: '#6366f1', label: 'Cursor' },
  'aider':         { color: 0x059669, cssColor: '#059669', label: 'Aider' },
  'copilot':       { color: 0x1f6feb, cssColor: '#1f6feb', label: 'Copilot' },
};

const DEFAULT_STYLE: FrameworkStyle = {
  color: 0x6b7280,
  cssColor: '#6b7280',
  label: '',
};

/**
 * Get the visual style for a given framework string.
 * Returns null when no framework is set (caller should skip rendering).
 */
export function getFrameworkStyle(framework: string | undefined | null): FrameworkStyle | null {
  if (!framework) return null;
  const key = framework.toLowerCase().trim();
  const known = KNOWN_FRAMEWORKS[key];
  if (known) return known;
  // Unknown framework: use raw string (truncated) with gray color
  const label = framework.length > 12 ? framework.slice(0, 12) : framework;
  return { ...DEFAULT_STYLE, label };
}
