import { ENERGY_COST_WORK_PER_SEC, TIME_SCALE, SHIFT_DURATION_GAME_HOURS } from '@otra/shared';
import type { ResidentEntity } from '../simulation/world.js';
import { getJob, getJobHolderCount, getJobs, assignJob, clearJob, logEvent } from '../db/queries.js';
import type { JobRow } from '../db/queries.js';

export interface ApplyJobResult {
  success: boolean;
  message: string;
  job?: JobRow;
  available_jobs?: Array<{ id: string; title: string; building_id: string | null; wage: number; openings: number }>;
}

export interface QuitJobResult {
  success: boolean;
  message: string;
}

/**
 * Apply for a job. Must be inside Council Hall.
 */
export function applyForJob(resident: ResidentEntity, jobId: string): ApplyJobResult {
  // Already employed?
  if (resident.employment) {
    return { success: false, message: `Already employed as ${resident.employment.job}. Quit first.` };
  }

  const job = getJob(jobId);
  if (!job) {
    const available = listAvailableJobs();
    return {
      success: false,
      message: `Unknown job_id "${jobId}". Send list_jobs to see available positions.`,
      available_jobs: available,
    };
  }

  // Check vacancy
  const holders = getJobHolderCount(jobId);
  if (holders >= job.max_positions) {
    return {
      success: false,
      message: `No openings for ${job.title} (${holders}/${job.max_positions} filled).`,
    };
  }

  // Assign the job
  assignJob(resident.id, jobId);
  resident.employment = { job: job.title, onShift: false };
  resident.currentJobId = jobId;
  resident.shiftStartTime = null;

  logEvent('apply_job', resident.id, null, resident.currentBuilding, resident.x, resident.y, {
    job_id: jobId, job_title: job.title,
  });

  return {
    success: true,
    message: `Hired as ${job.title}! Report to ${job.building_id || 'the city grounds'} to start your shift.`,
    job,
  };
}

/**
 * Quit current job.
 */
export function quitJob(resident: ResidentEntity): QuitJobResult {
  if (!resident.employment || !resident.currentJobId) {
    return { success: false, message: 'Not employed.' };
  }

  const jobTitle = resident.employment.job;
  clearJob(resident.id);

  logEvent('quit_job', resident.id, null, null, resident.x, resident.y, {
    job_id: resident.currentJobId, job_title: jobTitle,
  });

  resident.employment = null;
  resident.currentJobId = null;
  resident.shiftStartTime = null;

  return { success: true, message: `Quit job: ${jobTitle}.` };
}

/**
 * List all jobs with current openings.
 */
export function listAvailableJobs(): Array<{
  id: string; title: string; building_id: string | null; wage: number; openings: number;
  shift_hours: number; description: string;
}> {
  const jobs = getJobs();
  return jobs.map(j => {
    const holders = getJobHolderCount(j.id);
    return {
      id: j.id,
      title: j.title,
      building_id: j.building_id,
      wage: j.wage_per_shift,
      shift_hours: j.shift_duration_hours,
      openings: j.max_positions - holders,
      description: j.description,
    };
  });
}

/**
 * Track shift progress for an employed resident.
 * Called from world.ts updateNeeds at 10Hz.
 * Returns wage earned this tick (usually 0, non-zero when shift completes).
 */
export function updateShift(resident: ResidentEntity, dt: number): number {
  if (!resident.employment || !resident.currentJobId) return 0;

  const job = getJob(resident.currentJobId);
  if (!job) return 0;

  const isAtWorkplace = job.building_id
    ? resident.currentBuilding === job.building_id
    : !resident.currentBuilding; // Groundskeeper works outdoors

  if (isAtWorkplace && !resident.isSleeping && !resident.isDead) {
    // Start shift if not already clocked in
    if (resident.shiftStartTime === null) {
      resident.shiftStartTime = 0;
      resident.employment.onShift = true;
    }

    // Accumulate shift time (in game-seconds)
    resident.shiftStartTime += dt * TIME_SCALE;

    // Energy cost for working
    resident.needs.energy = Math.max(0, resident.needs.energy - ENERGY_COST_WORK_PER_SEC * dt);

    // Check if shift is complete
    const shiftDurationGameSec = job.shift_duration_hours * 3600;
    if (resident.shiftStartTime >= shiftDurationGameSec) {
      // Shift complete — pay wage
      resident.wallet += job.wage_per_shift;
      resident.shiftStartTime = null; // Reset for next shift
      resident.employment.onShift = false;

      logEvent('shift_complete', resident.id, null, job.building_id, resident.x, resident.y, {
        job_id: job.id, job_title: job.title, wage: job.wage_per_shift, wallet: resident.wallet,
      });

      resident.pendingNotifications.push(
        `Shift complete! Earned ${job.wage_per_shift} QUID as ${job.title}.`
      );

      return job.wage_per_shift;
    }
  } else {
    // Not at workplace — pause shift (don't reset, just pause)
    if (resident.employment.onShift) {
      resident.employment.onShift = false;
    }
  }

  return 0;
}
