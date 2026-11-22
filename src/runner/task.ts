import type winston from 'winston';
import {
  BOT_FIELD,
  NO_PRIORITY,
  PRIORITY_VALUES,
  STATUS_FIELD,
  STATUS_VALUES,
  TASK_LABEL,
} from '../constants/github.js';
import { closeLogger, createLogger, taskLogPath, TERMINAL } from '../utils/logger.js';
import type { Blockers, FoundTask, OpenPullRequest, RateLimitCall, TaskStart } from '../types.js';
import { formatRateLimitHeaders } from '../wrappers/github.js';
import { slugify } from '../utils/slugify.js';
import { Git } from '../wrappers/git.js';
import { cancelTask } from './cancel.js';
import { claimRefFor, claimTask, releaseTask } from './claim.js';
import { decideStart, followChain, type StartDecision } from './dependencies.js';
import { PickupAborted, prepareTask, StartCancelled } from './prepare-task.js';
import type { RunOpts, TaskOutcome } from './runner.js';
import { startSessionWithRateLimitLoop } from './session.js';
import { settleTask } from './settle-task.js';
import { readTaskState } from './task-state.js';

type ClaimOutcome =
  | { kind: 'won'; task: FoundTask; start: TaskStart }
  | { kind: 'empty' }
  | { kind: 'all-lost' }
  | { kind: 'all-cooling' }
  /** Every candidate waits on a blocker, or on a dependency ramonda does not support. */
  | { kind: 'all-blocked'; waiting: number[] };

/**
 * What one poll carries from level to level: the answers it would otherwise ask
 * Github for twice, and the tasks it found waiting.
 */
type PollPass = {
  decide: (blockedBy: Blockers) => Promise<StartDecision>;
  /** Issues this poll already tried to claim — two waiting tasks can share the head of a chain. */
  tried: Set<number>;
  waiting: number[];
};

/**
 * How long after finishing with an issue this process refuses to pick it up again.
 *
 * The poll filters on `status:"<todo>"`, and a task ends by moving that status —
 * which is not guaranteed to be visible to the filter the moment it is written.
 * The pass that starts immediately after a task finishes can therefore be handed
 * back the issue that task just published. The claim does not catch it: the ref
 * was deleted on release, so it is taken again cleanly, and a whole session goes
 * on redoing finished work before `pulls.create` answers 422 and the existing PR
 * is reused.
 *
 * Ten seconds: long enough to cover the lag, short enough that it never delays a
 * genuine re-queue by more than one poll. Cheap because it is only ever a
 * *skip* — the server-side filter remains the authority on what is eligible, and
 * this only declines to act on an answer this process has reason to distrust.
 */
const HANDLED_COOLDOWN_MS = 10_000;

/**
 * The candidates this process is willing to act on, freshest answer first.
 *
 * Prunes as it goes, so the map holds an entry per task in flight rather than one
 * per task the run has ever done.
 */
function withoutCoolingDown(candidates: FoundTask[], recentlyHandled: Map<number, number>): FoundTask[] {
  const now = Date.now();

  for (const [issue, handledAt] of recentlyHandled) {
    if (now - handledAt >= HANDLED_COOLDOWN_MS) {
      recentlyHandled.delete(issue);
    }
  }

  return candidates.filter((c) => !recentlyHandled.has(c.issue.number));
}

/**
 * The branch a task works on, which is also its worktree directory and — as
 * `refs/ramonda/<branch>` — its claim. One derivation for all three, so a process
 * that cannot take the claim cannot reach the worktree either.
 */
function branchFor(issue: { number: number; title: string }): string {
  return `${issue.number}-${slugify(issue.title)}`;
}

/** One poll's budget line, per priority level — log-only, like every other. */
function formatRateLimit(calls: RateLimitCall[]): string {
  return calls.map((c) => `[${c.priority}] ${formatRateLimitHeaders(c.rateLimit)}`).join('; ');
}

/**
 * Finds the task to work and claims it: the levels highest first, each level's
 * candidates in order, each candidate standing in for the head of its
 * dependency chain where it waits on a blocker.
 *
 * A level settles the poll once it holds a task that can start — claimed, or
 * lost to another process, as before blockers existed. A level where nothing can
 * start is walked past rather than slept on: a task waiting on its blocker is
 * one this process can do nothing about, and idling on it would hold up every
 * level below it.
 */
async function pickAndClaim(runOpts: RunOpts): Promise<ClaimOutcome> {
  const { github } = runOpts;
  const calls: RateLimitCall[] = [];
  let openPullRequests: Promise<OpenPullRequest[]> | undefined;
  const pass: PollPass = {
    decide: (blockedBy) =>
      decideStart({
        blockedBy,
        repoNameWithOwner: runOpts.repoNameWithOwner,
        baseBranch: runOpts.repoConfig.baseBranch,
        // Once per poll, and only if some blocker is done: one list answers
        // every blocker this poll looks up.
        openPullRequests: () =>
          (openPullRequests ??= github.fetchOpenPullRequests({ repoNameWithOwner: runOpts.repoNameWithOwner })),
      }),
    tried: new Set(),
    waiting: [],
  };

  try {
    for await (const level of github.candidateLevels({
      ghOwner: runOpts.ghOwner,
      ghProject: runOpts.ghProject,
      projectId: runOpts.meta.projectId,
      repoNameWithOwner: runOpts.repoNameWithOwner,
    })) {
      calls.push({ priority: level.priority, rateLimit: level.rateLimit });

      if (level.candidates.length === 0) {
        continue;
      }

      const eligible = withoutCoolingDown(level.candidates, runOpts.recentlyHandled);

      if (eligible.length === 0) {
        runOpts.mainLogger.info(
          `every candidate was handled by this run in the last ${HANDLED_COOLDOWN_MS / 1000}s ` +
            `(${level.candidates.map((c) => `#${c.issue.number}`).join(', ')})`
        );

        return { kind: 'all-cooling' };
      }

      const outcome = await claimFromLevel(runOpts, eligible, pass);

      if (outcome) {
        return outcome;
      }
    }
  } finally {
    runOpts.mainLogger.info(`rate-limit ${formatRateLimit(calls)}`);
  }

  return pass.waiting.length > 0 ? { kind: 'all-blocked', waiting: pass.waiting } : { kind: 'empty' };
}

/**
 * Claims the first task of a level that can start, or reports that every one
 * that could was lost to another process. Null means nothing on the level could
 * start at all, and the poll moves on to the next.
 *
 * Walked in order, not just the first tried and the rest dropped. Losing a claim
 * costs one call and settles nothing about the next candidate, so a process that
 * stopped at the first loss would sleep a full poll-pause over a queue it could
 * have worked — and several processes polling the same project would converge
 * on the same item every pass and mostly idle.
 */
async function claimFromLevel(runOpts: RunOpts, candidates: FoundTask[], pass: PollPass): Promise<ClaimOutcome | null> {
  let lost = false;

  for (const candidate of candidates) {
    const target = await resolveTarget(runOpts, candidate, pass);

    if (!target || pass.tried.has(target.task.issue.number)) {
      continue;
    }

    pass.tried.add(target.task.issue.number);
    const won = await claimTask({
      github: runOpts.github,
      repoNameWithOwner: runOpts.repoNameWithOwner,
      branch: branchFor(target.task.issue),
      sha: runOpts.claimSha,
    });

    if (!won) {
      runOpts.mainLogger.info(
        `claim already held on #${target.task.issue.number} (${claimRefFor(branchFor(target.task.issue))} exists)`
      );
      lost = true;

      continue;
    }

    runOpts.mainLogger.info(`claim won: #${target.task.issue.number} by ${runOpts.runId}`, TERMINAL);
    // The board's copy of who is working this, and nothing more — see `BOT_FIELD`.
    // Best-effort on purpose: the claim is already held by the time this runs, so
    // a failure here costs a label on a card and no correctness at all.
    await markBotField(runOpts, target.task);
    // Immediately, rather than once the worktree is ready. An item that is claimed
    // but still reads as Todo is one every other process keeps picking up and
    // losing the ref race on, and worktree prep and seeding can take minutes on a
    // cold checkout. Moving it here shrinks that window to a single mutation.
    await moveStatus(runOpts, target.task, {
      optionId: runOpts.meta.statusOptionInProgressId,
      name: STATUS_VALUES.inProgress,
    });

    return { kind: 'won', task: target.task, start: target.start };
  }

  return lost ? { kind: 'all-lost' } : null;
}

/**
 * The task a candidate stands for, and where it starts from: the candidate
 * itself where it can start, the head of its dependency chain where it waits on
 * a blocker and the head is a task ramonda can work — or nothing, where the
 * candidate waits, is skipped, or is cancelled here and now.
 */
async function resolveTarget(
  runOpts: RunOpts,
  candidate: FoundTask,
  pass: PollPass
): Promise<{ task: FoundTask; start: TaskStart } | null> {
  const n = candidate.issue.number;
  const decision = await pass.decide(candidate.blockedBy);

  switch (decision.kind) {
    case 'start':
      return { task: candidate, start: decision.start };
    case 'skip':
      runOpts.mainLogger.info(`skipping #${n}: ${decision.reason}`);
      pass.waiting.push(n);

      return null;
    case 'cancel':
      await cancelUnstartable(runOpts, candidate, decision.reason);

      return null;
    case 'wait':
      break;
  }

  const chain = await followChain({
    from: n,
    blocker: decision.blocker,
    fetchIssue: (number) =>
      runOpts.github.fetchChainIssue({
        repoNameWithOwner: runOpts.repoNameWithOwner,
        number,
        projectId: runOpts.meta.projectId,
      }),
    decide: pass.decide,
  });

  if (chain.kind === 'none') {
    runOpts.mainLogger.info(`#${n} ${chain.reason}`);
    pass.waiting.push(n);

    return null;
  }

  const root = chain.issue;

  // Cooling like any candidate would be — see `HANDLED_COOLDOWN_MS`. The head of
  // a chain this run just finished can read as `Todo` for a moment longer. The
  // map was pruned when this level was filtered, so what it holds is current.
  if (runOpts.recentlyHandled.has(root.number)) {
    pass.waiting.push(n);

    return null;
  }

  runOpts.mainLogger.info(
    `#${n} waits on #${decision.blocker.number} — working #${root.number} first, at the head of its chain`,
    TERMINAL
  );

  return {
    task: {
      itemId: root.itemId,
      issue: { number: root.number, title: root.title, body: root.body },
      priorityHit: `${candidate.priorityHit} via #${n}`,
      blockedBy: root.blockedBy,
    },
    start: chain.start,
  };
}

/**
 * Cancels a candidate whose dependency will not resolve on its own, before any
 * worktree exists for it: claimed first, so that two processes reaching it in
 * the same poll comment once between them.
 *
 * Counts against nothing. The no-PR budget is there to stop a run that burns
 * sessions, and this costs none — while counting it would let three misconfigured
 * cards end an overnight run.
 */
async function cancelUnstartable(runOpts: RunOpts, task: FoundTask, reason: string): Promise<void> {
  const branch = branchFor(task.issue);
  const won = await claimTask({
    github: runOpts.github,
    repoNameWithOwner: runOpts.repoNameWithOwner,
    branch,
    sha: runOpts.claimSha,
  });

  if (!won) {
    runOpts.mainLogger.info(`claim already held on #${task.issue.number} (${claimRefFor(branch)} exists)`);

    return;
  }

  await cancelClaimed({ opts: runOpts, task, branch, reason });
}

/**
 * Takes a claimed task off the board as `Cancelled`, with the reason on the
 * issue, without a task state to record it in — the one cancel that happens
 * before a session could have. Every write is best-effort, as the Cancel path's are.
 */
async function cancelClaimed(args: { opts: RunOpts; task: FoundTask; branch: string; reason: string }): Promise<void> {
  const { opts, task, branch, reason } = args;

  await moveStatus(opts, task, { optionId: opts.meta.statusOptionCancelledId, name: STATUS_VALUES.cancelled });

  try {
    await opts.github.postIssueComment({
      repoNameWithOwner: opts.repoNameWithOwner,
      issueNumber: task.issue.number,
      body: `Cancelled by ramonda (${new Date().toISOString()}): ${reason}`,
    });
  } catch (err) {
    opts.mainLogger.info(`warning: could not comment on #${task.issue.number}: ${(err as Error).message}`, TERMINAL);
  }

  await releaseClaim({ opts, task, branch, note: 'after cancelling it before pickup', revertToTodo: false });
  // The status move lags the filter like any other — see `HANDLED_COOLDOWN_MS` —
  // and a second cancel would mean a second comment.
  opts.recentlyHandled.set(task.issue.number, Date.now());
  opts.mainLogger.info(`task #${task.issue.number} cancelled — ${reason}`, TERMINAL);
}

/**
 * Moves an item's status, best-effort. The real claim is the ref, so a move that
 * does not land costs the task nothing — but an operator watching the board is
 * owed the reason a column did not change, which is why the failure is logged.
 */
async function moveStatus(
  runOpts: RunOpts,
  candidate: FoundTask,
  to: { optionId?: string; name: string }
): Promise<void> {
  if (!runOpts.meta.statusFieldId || !to.optionId) {
    return;
  }

  try {
    await runOpts.github.setProjectItemStatus({
      projectId: runOpts.meta.projectId,
      itemId: candidate.itemId,
      fieldId: runOpts.meta.statusFieldId,
      optionId: to.optionId,
    });
    runOpts.mainLogger.info(`#${candidate.issue.number} project status → ${to.name}`, TERMINAL);
  } catch (err) {
    runOpts.mainLogger.info(
      `warning: #${candidate.issue.number} project status → ${to.name} failed: ${(err as Error).message}`,
      TERMINAL
    );
  }
}

/** Records the run working an item, for the board. Never read back; never fatal. */
async function markBotField(runOpts: RunOpts, candidate: FoundTask): Promise<void> {
  try {
    await runOpts.github.setBotField({
      projectId: runOpts.meta.projectId,
      itemId: candidate.itemId,
      fieldId: runOpts.meta.botFieldId,
      value: runOpts.runId,
    });
  } catch (err) {
    runOpts.mainLogger.info(
      `warning: could not record the run on #${candidate.issue.number} in "${BOT_FIELD}": ${(err as Error).message}`
    );
  }
}

export async function runOneTask(opts: RunOpts): Promise<TaskOutcome> {
  // Log file only: this fires on every poll, and the idle line that follows it
  // is already the terminal's proof the loop is alive.
  opts.mainLogger.info(
    `query project: label=${TASK_LABEL} repo=${opts.repoNameWithOwner} ` +
      `priorities=${[...PRIORITY_VALUES, NO_PRIORITY].join(',')}`
  );

  const claimed = await pickAndClaim(opts);

  if (claimed.kind === 'empty') {
    return { kind: 'idle-empty' };
  }

  if (claimed.kind === 'all-lost') {
    return { kind: 'idle-all-claimed' };
  }

  if (claimed.kind === 'all-cooling') {
    return { kind: 'idle-cooling' };
  }

  if (claimed.kind === 'all-blocked') {
    return { kind: 'idle-blocked', waiting: claimed.waiting };
  }

  const { task, start } = claimed;
  const git = new Git(opts.workspacePath, { ghToken: opts.ghToken, commitIdentity: opts.commitIdentity });
  const issueTitleSlug = slugify(task.issue.title);
  // The same name the claim ref was taken under — one derivation, so the ref
  // released below cannot name a different task from the one that was claimed.
  const branch = branchFor(task.issue);
  // Named out here rather than inside the run, because the failure path below has
  // to find this task's state to know how much of the project it has to put back.
  const worktreePath = git.worktreePathFor({
    issue: task.issue.number,
    slug: issueTitleSlug,
  });

  try {
    return await runClaimedTask({ opts, task, start, git, branch, issueTitleSlug, worktreePath });
  } catch (err) {
    // Thrown ahead of the task state write, so the claim and the In progress move
    // are all this pickup took — and the cancel puts both back its own way.
    if (err instanceof StartCancelled) {
      await cancelClaimed({ opts, task, branch, reason: err.message });

      return { kind: 'unstartable', issueNumber: task.issue.number };
    }

    // Not a failure: the operator asked to stop, and stopping before a session
    // exists is the cheapest place to do it. Both checkpoints sit ahead of the
    // task state write, so there is no project state here beyond the claim.
    if (err instanceof PickupAborted) {
      await releaseClaim({
        opts,
        task,
        branch,
        note: 'after an aborted pickup',
        // Both checkpoints sit ahead of the session, so the In progress move made
        // at claim time is the only board state this pickup ever wrote.
        revertToTodo: true,
      });
      opts.mainLogger.info(`stop requested — abandoned pickup of #${task.issue.number} before its session`, TERMINAL);

      return { kind: 'aborted' };
    }

    // The unwind must never become the failure that gets reported. It is the
    // recovery, so a throw from inside it would bury the error that caused the
    // recovery in the first place — and leave the loop counting the wrong thing.
    try {
      await unwindFailedTask({ opts, task, branch, worktreePath, err: err as Error });
    } catch (unwindErr) {
      opts.mainLogger.info(
        `warning: could not fully unwind #${task.issue.number} (${(unwindErr as Error).message}) — check ` +
          `${claimRefFor(branch)} and the "${STATUS_FIELD}" field by hand`,
        TERMINAL
      );
    }

    throw err;
  } finally {
    // Every way out of a claimed task, verdict or not: what the next poll has to
    // distrust is the project's answer about this issue, and that is equally
    // stale whether the task completed, cancelled or threw.
    opts.recentlyHandled.set(task.issue.number, Date.now());
  }
}

/**
 * Puts the project back after a task threw somewhere it was not expected to.
 *
 * The task state decides how much there is to undo, because it is written in the
 * same stretch that moves status to In progress. A state file on disk therefore
 * means the item is carrying project state that outlives the claim, and dropping
 * the ref alone would leave it on the in-progress status — matching no Todo query, so
 * invisible to this bot and every other one, with nothing said on the issue about
 * why. With no state file the claim is the only thing this run ever took, and
 * releasing it is the whole undo.
 */
async function unwindFailedTask(args: {
  opts: RunOpts;
  task: FoundTask;
  branch: string;
  worktreePath: string;
  err: Error;
}): Promise<void> {
  const { opts, task, branch, worktreePath, err } = args;
  const taskState = await readTaskState(worktreePath);

  if (!taskState || taskState.completedAt || taskState.cancelledAt) {
    await releaseClaim({
      opts,
      task,
      branch,
      note: taskState ? 'after a failure past its verdict' : 'after a failure before its session',
      // A verdict already moved the item to readyForReview or cancelled; only a
      // pickup that never got a session is still sitting on In progress.
      revertToTodo: !taskState,
    });

    return;
  }

  const reason = await cancelTask({
    github: opts.github,
    taskState,
    worktreePath,
    reason: { kind: 'internalError', message: err.message },
    logger: opts.mainLogger,
  });
  opts.mainLogger.info(`task #${task.issue.number} cancelled — ${reason}`, TERMINAL);
}

/**
 * Drops the claim ref, and the board state that went with it.
 *
 * The ref first and the rest after, in that order deliberately: the ref is what
 * another process is blocked on. A failure on it is worth the terminal — the
 * issue stays claimed until somebody deletes it — while a failure on the field
 * leaves a stale name on a card that the next run to take the issue overwrites.
 *
 * `revertToTodo` is what tells the two kinds of release apart. A pickup that
 * never reached its session leaves the item on In progress with nothing to
 * explain it, matching no `Todo` query and so invisible to every process
 * including this one — that one has to be put back. A release *past* a verdict
 * must not be: the item is already on `readyForReview` or `cancelled`, and
 * dragging it to Todo would re-queue work that is finished.
 */
async function releaseClaim(args: {
  opts: RunOpts;
  task: FoundTask;
  branch: string;
  /** What the release undoes, so the log line says which path it came down. */
  note: string;
  revertToTodo: boolean;
}): Promise<void> {
  const { opts, task, branch, note } = args;

  if (args.revertToTodo) {
    await moveStatus(opts, task, {
      optionId: opts.meta.statusOptionTodoId,
      name: STATUS_VALUES.todo,
    });
  }

  try {
    await releaseTask({ github: opts.github, repoNameWithOwner: opts.repoNameWithOwner, branch });
    opts.mainLogger.info(`released claim on #${task.issue.number} ${note}`, TERMINAL);
  } catch (err) {
    opts.mainLogger.info(
      `warning: could not release the claim on #${task.issue.number} (${(err as Error).message}) — ` +
        `delete it by hand with: git push origin --delete ${claimRefFor(branch)}`,
      TERMINAL
    );
  }

  try {
    await opts.github.clearBotField({
      projectId: opts.meta.projectId,
      itemId: task.itemId,
      fieldId: opts.meta.botFieldId,
    });
  } catch (err) {
    opts.mainLogger.info(`warning: could not clear "${BOT_FIELD}" on #${task.issue.number}: ${(err as Error).message}`);
  }
}

/**
 * Opens the task's log, runs it, and closes the log afterwards — whichever way
 * the task ended.
 *
 * The close is the point of the split. A file transport holds its stream open
 * for the life of the logger, so a loop that runs for weeks would otherwise carry
 * an open descriptor for every task it had ever picked up. The branch and
 * worktree are named by the caller, which needs them for the failure path too.
 */
async function runClaimedTask(args: {
  opts: RunOpts;
  task: FoundTask;
  start: TaskStart;
  git: Git;
  branch: string;
  issueTitleSlug: string;
  worktreePath: string;
}): Promise<TaskOutcome> {
  const { opts, task, start, git, branch, issueTitleSlug, worktreePath } = args;

  // Pickup is seconds of git and network work before there is any child to
  // signal, so a stop arriving inside it has to be read rather than delivered.
  if (opts.shutdownSignal.aborted) {
    throw new PickupAborted();
  }

  const taskLogFile = taskLogPath({
    runId: opts.runId,
    issue: task.issue.number,
    slug: issueTitleSlug,
  });
  const taskLog = createLogger(taskLogFile);

  try {
    return await runTaskSession({ opts, task, start, git, branch, worktreePath, taskLogFile, taskLog });
  } finally {
    await closeLogger(taskLog);
  }
}

async function runTaskSession(args: {
  opts: RunOpts;
  task: FoundTask;
  start: TaskStart;
  git: Git;
  branch: string;
  worktreePath: string;
  taskLogFile: string;
  taskLog: winston.Logger;
}): Promise<TaskOutcome> {
  const { opts, task, start, git, branch, worktreePath, taskLogFile, taskLog } = args;
  const stacked = start.stackedOn ? ` stacked on #${start.blocker?.number} (${start.stackedOn.branch})` : '';

  opts.mainLogger.info(
    `pickup #${task.issue.number} ${task.issue.title} [priority=${task.priorityHit}]${stacked}`,
    TERMINAL
  );
  opts.mainLogger.info(`branch=${branch} base=${start.baseBranch} worktree=${worktreePath} log=${taskLogFile}`);

  taskLog.info(`task pickup: #${task.issue.number} "${task.issue.title}" priority=${task.priorityHit}${stacked}`);
  taskLog.info(`branch=${branch} base=${start.baseBranch} worktree=${worktreePath}`);

  const { brief, taskState } = await prepareTask({
    opts,
    task,
    start,
    git,
    branch,
    worktreePath,
    taskLog,
    taskLogFile,
  });
  const { claudeSessionId } = taskState;

  taskLog.info(`session start: ${claudeSessionId}`);
  opts.mainLogger.info(`session start #${task.issue.number} ${claudeSessionId}`);

  const result = await startSessionWithRateLimitLoop({
    claudeBin: opts.claudeBin,
    model: opts.model,
    cwd: worktreePath,
    sessionId: claudeSessionId,
    initialPrompt: brief,
    commitIdentity: opts.commitIdentity,
    shutdownSignal: opts.shutdownSignal,
    onSessionOutput: (line) => {
      // `TERMINAL`: with no terminal attached to the child, this is the only
      // thing an operator watching a plain run ever sees of the session.
      taskLog.info(`claude: ${line}`, TERMINAL);
    },
    onLimitHit: ({ hit, waitMs, reason }) => {
      const mins = Math.round(waitMs / 60_000);
      const secs = Math.round(waitMs / 1000);
      const dur = mins > 0 ? `${mins}m` : `${secs}s`;
      const msg = `limit hit type=${hit.errorType} wait=${dur} (${reason})`;
      taskLog.info(`session: ${msg}`);
      opts.mainLogger.info(`session ${claudeSessionId}: ${msg}`, TERMINAL);

      // A fallback wait is the one outcome here that looks fine and is not. The
      // duration is plausible, so nothing about the line above suggests ramonda
      // failed to read anything — while the output and the transcript it reads
      // are Claude Code's, with no promised format, so the day a field is renamed
      // every wait quietly becomes this one. Said out loud, with the path, so the
      // first occurrence is noticed rather than the hundredth.
      if (reason === 'fallback') {
        const where = hit.transcriptPath ? `the session output or ${hit.transcriptPath}` : 'the session output';
        const warning =
          `warning: no rate-limit reset found in ${where} — waiting ${dur} on the fallback window. ` +
          `If claude resumes well before that, ramonda is idling on quota you have; ` +
          `the format it reads the reset from may have changed.`;
        taskLog.info(`session: ${warning}`);
        opts.mainLogger.info(`session ${claudeSessionId}: ${warning}`, TERMINAL);
      }
    },
    onResume: ({ hit }) => {
      const msg = `resuming after ${hit.errorType}`;
      taskLog.info(`session: ${msg}`);
      opts.mainLogger.info(`session ${claudeSessionId}: ${msg}`, TERMINAL);
    },
  });
  taskLog.info(`session exit: code=${result.exitCode} signal=${result.signal ?? 'none'}`);
  opts.mainLogger.info(`session exit code=${result.exitCode} signal=${result.signal ?? 'none'}`);

  return settleTask({
    opts,
    task,
    worktreePath,
    taskLog,
    // The hooks patch the file the loop wrote, so the verdict is read back off
    // disk rather than off the copy this process has been holding.
    taskState: (await readTaskState(worktreePath)) ?? taskState,
    session: result,
  });
}
