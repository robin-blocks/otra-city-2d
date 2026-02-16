import { PETITION_COST_QUID, ENERGY_COST_WRITE_PETITION, ENERGY_COST_VOTE } from '@otra/shared';
import type { ResidentEntity } from '../simulation/world.js';
import {
  createPetition, votePetition as dbVotePetition,
  getPetition, hasVoted, logEvent,
} from '../db/queries.js';
import type { PetitionRow } from '../db/queries.js';
import { v4 as uuid } from 'uuid';

export interface WritePetitionResult {
  success: boolean;
  message: string;
  petition?: PetitionRow;
}

export interface VoteResult {
  success: boolean;
  message: string;
}

/**
 * Write a new petition at the Council Hall.
 * Free to write — no QUID or energy cost.
 */
export function writePetition(
  resident: ResidentEntity,
  category: string,
  description: string
): WritePetitionResult {
  if (resident.wallet < PETITION_COST_QUID) {
    return {
      success: false,
      message: `Not enough QUID (need ${PETITION_COST_QUID}, have ${resident.wallet})`,
    };
  }
  if (resident.needs.energy < ENERGY_COST_WRITE_PETITION) {
    return { success: false, message: 'Not enough energy' };
  }
  if (!category || category.length > 50) {
    return { success: false, message: 'Category must be 1-50 characters' };
  }
  if (!description || description.length > 500) {
    return { success: false, message: 'Description must be 1-500 characters' };
  }

  // Deduct costs
  resident.wallet -= PETITION_COST_QUID;
  resident.needs.energy -= ENERGY_COST_WRITE_PETITION;

  const id = uuid();
  const petition = createPetition(id, resident.id, category, description);

  logEvent('write_petition', resident.id, null, 'council-hall', resident.x, resident.y, {
    petition_id: id, category, description, cost: PETITION_COST_QUID,
  });

  return {
    success: true,
    message: `Petition filed: "${category}". Your voice matters — thank you for participating!`,
    petition,
  };
}

/**
 * Vote on an existing petition at the Council Hall.
 * Each resident can only vote once per petition.
 */
export function voteOnPetition(
  resident: ResidentEntity,
  petitionId: string,
  vote: string = 'for'
): VoteResult {
  if (resident.needs.energy < ENERGY_COST_VOTE) {
    return { success: false, message: 'Not enough energy to vote' };
  }

  const petition = getPetition(petitionId);
  if (!petition) {
    return { success: false, message: 'Petition not found' };
  }
  if (petition.status !== 'open') {
    return { success: false, message: 'Petition is closed' };
  }
  if (hasVoted(petitionId, resident.id)) {
    return { success: false, message: 'Already voted on this petition' };
  }

  // Deduct energy
  resident.needs.energy -= ENERGY_COST_VOTE;

  // Cast vote
  const voteValue = vote === 'against' ? 'against' : 'for';
  dbVotePetition(petitionId, resident.id, voteValue);

  logEvent('vote_petition', resident.id, null, 'council-hall', resident.x, resident.y, {
    petition_id: petitionId, vote: voteValue,
  });

  return {
    success: true,
    message: `Voted "${voteValue}" on petition "${petition.category}".`,
  };
}
