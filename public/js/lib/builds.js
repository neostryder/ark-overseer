import { STRINGS } from '../strings.js';

// The branch an install runs on, as a person reads it. Steam's own name is kept for any other branch.
export function branchName(branch) {
  return STRINGS.builds.branches[branch] ?? branch ?? STRINGS.builds.branches.public;
}
export const isTestBranch = (branch) => Boolean(branch) && branch !== 'public';

const DAY_MS = 24 * 60 * 60 * 1000;
export const FRESH_DAYS = 14;

// Builds worth a banner: a build Steam changed in the last two weeks that nobody has dismissed yet.
// `dismissed` maps a branch to the build id that was dismissed.
export function newBuilds(branches, dismissed = {}, now = Date.now()) {
  return (branches ?? []).filter((row) => {
    const changed = Date.parse(row.changed_at);
    return Number.isFinite(changed) && now - changed <= FRESH_DAYS * DAY_MS && dismissed[row.branch] !== row.build_id;
  });
}

export function bannerText(rows, relativeTime, now = Date.now()) {
  return rows.map((row) =>
    STRINGS.builds.bannerLine
      .replace('{branch}', branchName(row.branch))
      .replace('{build}', row.build_id)
      .replace('{when}', relativeTime(Date.parse(row.changed_at), now)),
  );
}

// The sentence that tells someone what moving to a branch does, from the guard the server will enforce.
export function switchWarning(from, to) {
  if (isTestBranch(to) && !isTestBranch(from)) return STRINGS.builds.warnToTest;
  if (!isTestBranch(to) && isTestBranch(from)) return STRINGS.builds.warnToLive;
  return STRINGS.builds.warnBetween;
}
