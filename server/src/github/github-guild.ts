/**
 * GitHub Guild — core logic for linking GitHub accounts and claiming rewards.
 *
 * Bots prove GitHub ownership by including their passport number in any
 * issue, PR, or comment on the repo, then calling link_github at the Guild.
 * Rewards are claimed by visiting the Issues or PR desk inside the building.
 */

import {
  GITHUB_REPO, GITHUB_CLAIM_COOLDOWN_SEC,
  GITHUB_ISSUE_REWARD, GITHUB_PR_EASY_REWARD, GITHUB_PR_MEDIUM_REWARD, GITHUB_PR_HARD_REWARD,
} from '@otra/shared';
import {
  updateResidentGithub, getResidentByGithub,
  getClaimByNumber, insertGithubClaim, updateLastGithubClaimTime,
} from '../db/queries.js';
import type { ResidentEntity } from '../simulation/world.js';

// === GitHub API helper ===

const GITHUB_API = 'https://api.github.com';
const cache = new Map<string, { data: unknown; expires: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

async function githubFetch(path: string): Promise<unknown> {
  const url = `${GITHUB_API}${path}`;
  const cached = cache.get(url);
  if (cached && cached.expires > Date.now()) return cached.data;

  const headers: Record<string, string> = {
    'Accept': 'application/vnd.github+json',
    'User-Agent': 'otra-city-server',
  };
  if (process.env.GITHUB_TOKEN) {
    headers['Authorization'] = `Bearer ${process.env.GITHUB_TOKEN}`;
  }

  const res = await fetch(url, { headers });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`GitHub API ${res.status}: ${body.slice(0, 200)}`);
  }

  const data = await res.json();
  cache.set(url, { data, expires: Date.now() + CACHE_TTL_MS });
  return data;
}

// === Result types ===

export interface GuildResult {
  ok: boolean;
  message: string;
  reward?: number;
  tier?: string;
  github_number?: number;
}

// === Link GitHub account ===

const USERNAME_RE = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/;

export async function linkGithub(resident: ResidentEntity, githubUsername: string): Promise<GuildResult> {
  // Already linked?
  if (resident.githubUsername) {
    return { ok: false, message: `Already linked to GitHub user "${resident.githubUsername}".` };
  }

  // Validate format
  if (!USERNAME_RE.test(githubUsername)) {
    return { ok: false, message: 'Invalid GitHub username format.' };
  }

  // Check if this GitHub user is already linked to another resident
  const existing = getResidentByGithub(githubUsername);
  if (existing && existing.id !== resident.id) {
    return { ok: false, message: 'This GitHub username is already linked to another resident.' };
  }

  // Verify ownership: search for passport number in issues/PRs/comments authored by this user
  try {
    const searchResult = await githubFetch(
      `/search/issues?q=${encodeURIComponent(resident.passportNo)}+repo:${GITHUB_REPO}+author:${encodeURIComponent(githubUsername)}&per_page=1`
    ) as { total_count: number };

    if (searchResult.total_count === 0) {
      return {
        ok: false,
        message: `Verification failed. Include "${resident.passportNo}" in any issue, PR, or comment on ${GITHUB_REPO} from the account "${githubUsername}", then try again.`,
      };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return { ok: false, message: `GitHub API error: ${msg}` };
  }

  // Link it
  updateResidentGithub(resident.id, githubUsername);
  resident.githubUsername = githubUsername;

  return { ok: true, message: `GitHub account "${githubUsername}" linked successfully.` };
}

// === Claim Issue reward ===

export async function claimIssue(
  resident: ResidentEntity, issueNumber: number, worldTime: number
): Promise<GuildResult> {
  // Pre-checks
  const precheck = checkClaimPreconditions(resident, worldTime);
  if (precheck) return precheck;

  // Already claimed?
  if (getClaimByNumber('issue', issueNumber)) {
    return { ok: false, message: `Issue #${issueNumber} has already been claimed.` };
  }

  // Fetch from GitHub
  let issue: { user: { login: string }; pull_request?: unknown; labels: Array<{ name: string }>; state: string };
  try {
    issue = await githubFetch(`/repos/${GITHUB_REPO}/issues/${issueNumber}`) as typeof issue;
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return { ok: false, message: `GitHub API error: ${msg}` };
  }

  // Must not be a PR (GitHub returns PRs via the issues endpoint too)
  if (issue.pull_request) {
    return { ok: false, message: `#${issueNumber} is a pull request, not an issue. Use the PR desk instead.` };
  }

  // Author must match
  if (issue.user.login.toLowerCase() !== resident.githubUsername!.toLowerCase()) {
    return { ok: false, message: `Issue #${issueNumber} was authored by "${issue.user.login}", not "${resident.githubUsername}".` };
  }

  // Must have reward:issue label
  const hasLabel = issue.labels.some(l => l.name === 'reward:issue');
  if (!hasLabel) {
    return { ok: false, message: `Issue #${issueNumber} does not have the "reward:issue" label yet. Wait for admin approval.` };
  }

  // Success — record claim and credit wallet
  const reward = GITHUB_ISSUE_REWARD;
  insertGithubClaim({
    resident_id: resident.id,
    github_username: resident.githubUsername!,
    claim_type: 'issue',
    github_number: issueNumber,
    reward_tier: 'issue',
    reward_amount: reward,
    claimed_at: Date.now(),
  });
  updateLastGithubClaimTime(resident.id, worldTime);
  resident.lastGithubClaimTime = worldTime;
  resident.wallet += reward;

  return { ok: true, message: `Issue #${issueNumber} reward claimed: +${reward} QUID.`, reward, tier: 'issue', github_number: issueNumber };
}

// === Claim PR reward ===

const TIER_REWARDS: Record<string, number> = {
  'reward:easy': GITHUB_PR_EASY_REWARD,
  'reward:medium': GITHUB_PR_MEDIUM_REWARD,
  'reward:hard': GITHUB_PR_HARD_REWARD,
};

export async function claimPr(
  resident: ResidentEntity, prNumber: number, worldTime: number
): Promise<GuildResult> {
  // Pre-checks
  const precheck = checkClaimPreconditions(resident, worldTime);
  if (precheck) return precheck;

  // Already claimed?
  if (getClaimByNumber('pr', prNumber)) {
    return { ok: false, message: `PR #${prNumber} has already been claimed.` };
  }

  // Fetch from GitHub
  let pr: { user: { login: string }; merged: boolean; labels: Array<{ name: string }> };
  try {
    pr = await githubFetch(`/repos/${GITHUB_REPO}/pulls/${prNumber}`) as typeof pr;
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return { ok: false, message: `GitHub API error: ${msg}` };
  }

  // Must be merged
  if (!pr.merged) {
    return { ok: false, message: `PR #${prNumber} is not merged yet.` };
  }

  // Author must match
  if (pr.user.login.toLowerCase() !== resident.githubUsername!.toLowerCase()) {
    return { ok: false, message: `PR #${prNumber} was authored by "${pr.user.login}", not "${resident.githubUsername}".` };
  }

  // Find reward tier label
  let rewardLabel: string | null = null;
  for (const label of pr.labels) {
    if (TIER_REWARDS[label.name] !== undefined) {
      rewardLabel = label.name;
      break;
    }
  }
  if (!rewardLabel) {
    return { ok: false, message: `PR #${prNumber} does not have a reward label (reward:easy, reward:medium, or reward:hard). Wait for admin review.` };
  }

  const reward = TIER_REWARDS[rewardLabel];
  const tier = rewardLabel.replace('reward:', '');

  insertGithubClaim({
    resident_id: resident.id,
    github_username: resident.githubUsername!,
    claim_type: 'pr',
    github_number: prNumber,
    reward_tier: tier,
    reward_amount: reward,
    claimed_at: Date.now(),
  });
  updateLastGithubClaimTime(resident.id, worldTime);
  resident.lastGithubClaimTime = worldTime;
  resident.wallet += reward;

  return { ok: true, message: `PR #${prNumber} (${tier}) reward claimed: +${reward} QUID.`, reward, tier, github_number: prNumber };
}

// === Helpers ===

function checkClaimPreconditions(resident: ResidentEntity, worldTime: number): GuildResult | null {
  if (!resident.githubUsername) {
    return { ok: false, message: 'Link your GitHub account first with link_github.' };
  }

  const elapsed = worldTime - resident.lastGithubClaimTime;
  if (elapsed < GITHUB_CLAIM_COOLDOWN_SEC) {
    const remaining = Math.ceil(GITHUB_CLAIM_COOLDOWN_SEC - elapsed);
    return { ok: false, message: `Please wait ${remaining} more game-seconds before claiming again.` };
  }

  return null;
}
