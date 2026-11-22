import { STATUS_VALUES, TASK_LABEL } from '../constants/github.js';
import type { Blocker, Blockers, ChainIssue, OpenPullRequest, TaskStart } from '../types.js';

/**
 * The columns a blocker has to have reached before the work it blocks can start:
 * review, and every column past it.
 *
 * The status rather than the bare existence of a PR, because a PR stays open
 * while its issue is sent back to `Todo` for rework — and work stacked on it then
 * would be built on the version the review just turned down.
 */
const DONE_STATUSES: ReadonlySet<string> = new Set([
  STATUS_VALUES.readyForReview,
  STATUS_VALUES.readyForTest,
  STATUS_VALUES.testing,
  STATUS_VALUES.tested,
  STATUS_VALUES.delivered,
  STATUS_VALUES.done,
]);

/**
 * How many links back from a waiting task the poll follows looking for one it
 * can work. Every link is a call of its own, made on every poll the task waits
 * through, so the walk has to end somewhere — and a chain this long is one
 * somebody should be looking at anyway.
 */
export const MAX_CHAIN_DEPTH = 10;

/**
 * Whether an issue can start, by what blocks it.
 *
 * - `start`: no blocker, or one that is done — with where to cut the branch from.
 * - `wait`: a blocker that is not done yet. The caller follows the chain from it.
 * - `skip`: a dependency ramonda does not support. The issue stays where it is.
 * - `cancel`: a dependency that will not resolve on its own. Somebody has to fix
 *   it, so the issue is cancelled with the reason, which says how.
 */
export type StartDecision =
  | { kind: 'start'; start: TaskStart }
  | { kind: 'wait'; blocker: Blocker }
  | { kind: 'skip'; reason: string }
  | { kind: 'cancel'; reason: string };

/** Appended to every cancel this module words, since every one of them has the same fix. */
const REQUEUE_HINT = `Fix the dependency, then move this issue back to ${STATUS_VALUES.todo}.`;

/**
 * Where a blocker's work is, found by the branch ramonda would have named for it.
 *
 * By prefix rather than by the whole name: the slug half follows the issue title,
 * and a title edited after the PR was opened would otherwise lose its branch. The
 * dash is what keeps `#1` from matching `12-...`.
 */
function branchesOf(blocker: Blocker, pulls: OpenPullRequest[], repoNameWithOwner: string): OpenPullRequest[] {
  return pulls.filter(
    (pr) => pr.headRepoNameWithOwner === repoNameWithOwner && pr.headRefName.startsWith(`${blocker.number}-`)
  );
}

/**
 * Settles whether an issue can start, and from which branch, by its blockers.
 *
 * Asked once, at pickup. Nothing that happens to the blocker afterwards — more
 * commits, a merge, a close — reaches a task that has already started.
 *
 * `openPullRequests` is called only once a blocker is done, which is the one
 * case that needs its branch, so a poll with nothing to stack on never pays for
 * the call.
 */
export async function decideStart(args: {
  blockedBy: Blockers;
  repoNameWithOwner: string;
  baseBranch: string;
  openPullRequests: () => Promise<OpenPullRequest[]>;
}): Promise<StartDecision> {
  const { blockedBy, repoNameWithOwner, baseBranch } = args;
  const [blocker] = blockedBy.blockers;

  if (blockedBy.totalCount === 0 || !blocker) {
    return { kind: 'start', start: { baseBranch } };
  }

  // A branch can be cut from one branch, and a PR can target one. Refused even
  // where all but one are finished, so the rule is the same at every pickup.
  if (blockedBy.totalCount > 1) {
    const named = blockedBy.blockers.map((b) => `#${b.number}`).join(', ');
    const more = blockedBy.totalCount > blockedBy.blockers.length ? ', …' : '';

    return {
      kind: 'cancel',
      reason:
        `blocked by ${blockedBy.totalCount} issues (${named}${more}) — ramonda can build on only one. ` +
        `Leave one blocker, then move this issue back to ${STATUS_VALUES.todo}.`,
    };
  }

  if (blocker.repoNameWithOwner !== repoNameWithOwner) {
    return { kind: 'skip', reason: `blocked by ${blocker.repoNameWithOwner}#${blocker.number}, in another repository` };
  }

  if (!blocker.status || !DONE_STATUSES.has(blocker.status)) {
    return { kind: 'wait', blocker };
  }

  const branches = branchesOf(blocker, await args.openPullRequests(), repoNameWithOwner);

  if (branches.length === 1) {
    const [pr] = branches;

    return {
      kind: 'start',
      start: {
        baseBranch: pr.headRefName,
        blocker: { number: blocker.number, title: blocker.title },
        stackedOn: { url: pr.url, branch: pr.headRefName },
      },
    };
  }

  if (branches.length > 1) {
    return {
      kind: 'cancel',
      reason:
        `blocker #${blocker.number} has ${branches.length} open PRs (${branches.map((pr) => pr.url).join(', ')}) — ` +
        `ramonda cannot tell which branch to build on. ${REQUEUE_HINT}`,
    };
  }

  // No branch left to build on, and the issue closed as done: its work is in the
  // base branch, which is where this one starts from.
  if (blocker.state === 'CLOSED' && blocker.stateReason === 'COMPLETED') {
    return { kind: 'start', start: { baseBranch, blocker: { number: blocker.number, title: blocker.title } } };
  }

  const why =
    blocker.state === 'CLOSED'
      ? `was closed as ${(blocker.stateReason ?? 'unknown').toLowerCase().replace(/_/g, ' ')}`
      : `is on "${blocker.status}"`;

  return {
    kind: 'cancel',
    reason: `blocker #${blocker.number} ${why}, with no open PR from a branch named "${blocker.number}-…" to build on. ${REQUEUE_HINT}`,
  };
}

/** What following a chain back from a waiting task turned up. */
export type ChainOutcome =
  /** The first link that can start, and that ramonda can work itself. */
  | { kind: 'root'; issue: ChainIssue & { itemId: string }; start: TaskStart }
  /** Nothing ramonda can work: the waiting task keeps waiting, for this reason. */
  | { kind: 'none'; reason: string };

/** Whether an issue is one the poll itself would have picked up, had its level been reached. */
function isWorkable(issue: ChainIssue): issue is ChainIssue & { itemId: string } {
  return (
    issue.state === 'OPEN' &&
    issue.labels.includes(TASK_LABEL) &&
    issue.status === STATUS_VALUES.todo &&
    issue.itemId !== undefined
  );
}

/**
 * Follows a waiting task's chain of blockers back to the first one that can
 * start, so the work at the head of the chain is done ahead of everything else
 * on the task's level — rather than waiting for the poll to reach the level
 * the head happens to sit on.
 *
 * Only the direct blocker came with the poll; every link past it is read here,
 * one call each. A link that cannot start for any reason other than waiting —
 * too many blockers, a dependency to be cancelled — ends the walk without
 * acting on it: the poll cancels it when it reaches it on its own.
 */
export async function followChain(args: {
  /** The waiting task. */
  from: number;
  /** Its direct blocker, which is not done. */
  blocker: Blocker;
  fetchIssue: (number: number) => Promise<ChainIssue | null>;
  decide: (blockedBy: Blockers) => Promise<StartDecision>;
}): Promise<ChainOutcome> {
  const path = [`#${args.from}`];
  const visited = new Set<number>([args.from]);
  let blocker = args.blocker;

  for (let depth = 1; depth <= MAX_CHAIN_DEPTH; depth++) {
    path.push(`#${blocker.number}`);
    const none = (why: string): ChainOutcome => ({ kind: 'none', reason: `waits on ${path.join(' → ')}: ${why}` });

    if (visited.has(blocker.number)) {
      return none('the chain loops');
    }

    visited.add(blocker.number);
    const issue = await args.fetchIssue(blocker.number);

    if (!issue) {
      return none(`#${blocker.number} could not be read`);
    }

    const decision = await args.decide(issue.blockedBy);

    if (decision.kind === 'wait') {
      blocker = decision.blocker;
      continue;
    }

    if (decision.kind !== 'start') {
      return none(decision.reason);
    }

    if (!isWorkable(issue)) {
      return none(
        `#${issue.number} is ${issue.state === 'OPEN' ? `on "${issue.status ?? 'no status'}"` : 'closed'}` +
          (issue.labels.includes(TASK_LABEL) ? '' : ` without the "${TASK_LABEL}" label`)
      );
    }

    return { kind: 'root', issue, start: decision.start };
  }

  return { kind: 'none', reason: `waits on ${path.join(' → ')} → …: the chain is longer than ${MAX_CHAIN_DEPTH}` };
}
