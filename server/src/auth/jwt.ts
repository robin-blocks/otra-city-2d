import jwt from 'jsonwebtoken';

const SECRET = process.env.JWT_SECRET || 'otra-city-dev-secret-change-me';

export interface TokenPayload {
  residentId: string;
  passportNo: string;
  type: 'AGENT' | 'HUMAN';
}

export function signToken(payload: TokenPayload): string {
  return jwt.sign(payload, SECRET, { expiresIn: '30d' });
}

export function verifyToken(token: string): TokenPayload | null {
  try {
    return jwt.verify(token, SECRET) as TokenPayload;
  } catch {
    return null;
  }
}
