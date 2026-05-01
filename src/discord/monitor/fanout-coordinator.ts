/**
 * Fan-Out Coordinator — Sequential Turn-Taking for Multi-Agent Channels
 *
 * When a message arrives in a fan-out channel, each bot receives the Discord
 * event independently. The coordinator collects these registrations, then
 * releases agents one at a time so each sees the accumulated conversation.
 */

import { isSilentReplyText } from "../../auto-reply/tokens.js";
import { logVerbose } from "../../globals.js";
import type { DiscordMessagePreflightContext } from "./message-handler.preflight.types.js";

function fanoutLog(msg: string): void {
  const ts = new Date().toISOString();
  console.log(`${ts} [fanout] ${msg}`);
  logVerbose(`fanout: ${msg}`);
}

const AGENT_COLLECTION_WINDOW_MS = 1500;
const AGENT_RESPONSE_TIMEOUT_MS = 45_000;
const DEFAULT_MAX_ROUNDS = 20;

const FANOUT_GUIDANCE =
  "> Shared agent conversation. Respond only if addressed, the topic is in your domain, or you have useful input. Otherwise NO_REPLY.";

// ── Types ──

type AgentRegistration = {
  accountId: string;
  botUserId: string;
  ctx: DiscordMessagePreflightContext;
  processMessage: (ctx: DiscordMessagePreflightContext) => Promise<void>;
  skipFirstRound?: boolean; // true for the agent that sent the triggering message
};

type PendingRound = {
  triggerMessageId: string;
  triggerAccountId: string | undefined; // accountId of the bot that sent the trigger (for self-exclusion)
  registrations: AgentRegistration[];
  collectionTimer: ReturnType<typeof setTimeout> | null;
  mentionedBotIds: string[];
};

type RoundResult = {
  accountId: string;
  botUserId: string;
  responded: boolean; // true = sent content (non-NO_REPLY)
  responseText?: string;
  skipped?: boolean; // true = no new messages, agent was not invoked
};

type ConversationMessage = {
  agentId: string; // accountId of sender, or "human" for external messages
  content: string;
  index: number; // monotonic index within the conversation
};

type ChannelState = {
  currentRound: number;
  isProcessing: boolean;
  pendingRound: PendingRound | null;
  previousRoundResponders: Set<string>; // accountIds that responded in previous round
  roundLimit: number;
  /** Track pending response callbacks per accountId */
  responseCallbacks: Map<string, (responseText: string | undefined) => void>;
  /** Per-agent watermark tracking for message delivery */
  conversation: {
    messages: ConversationMessage[];
    watermarks: Map<string, number>; // agentId → last seen message index
    nextIndex: number;
  };
};

// ── Singleton state ──

const channelStates = new Map<string, ChannelState>();

function getOrCreateChannelState(channelId: string, maxRounds?: number): ChannelState {
  let state = channelStates.get(channelId);
  if (!state) {
    state = {
      currentRound: 0,
      isProcessing: false,
      pendingRound: null,
      previousRoundResponders: new Set(),
      roundLimit: maxRounds ?? DEFAULT_MAX_ROUNDS,
      responseCallbacks: new Map(),
      conversation: {
        messages: [],
        watermarks: new Map(),
        nextIndex: 0,
      },
    };
    channelStates.set(channelId, state);
  }
  if (maxRounds !== undefined) {
    state.roundLimit = maxRounds;
  }
  return state;
}

// ── Public API ──

/**
 * Register an agent to participate in a fan-out round for a message.
 * Called from each bot's message handler when a fan-out message is detected.
 *
 * Returns true if the coordinator will handle processing (caller should NOT process).
 * Returns false if fan-out coordination is not applicable (caller should process normally).
 */
export function registerFanOutAgent(params: {
  channelId: string;
  messageId: string;
  accountId: string;
  botUserId: string;
  triggerBotUserId?: string; // botUserId of message author (for self-exclusion)
  mentionedUserIds: string[];
  ctx: DiscordMessagePreflightContext;
  processMessage: (ctx: DiscordMessagePreflightContext) => Promise<void>;
  maxRounds?: number;
}): boolean {
  const { channelId, messageId, accountId, botUserId, ctx, processMessage, maxRounds } = params;
  const state = getOrCreateChannelState(channelId, maxRounds);

  // Self-exclusion: if this bot sent the triggering message, skip Round 1
  // but participate in Round 2+ so they can see other agents' responses
  const isTriggerAgent = Boolean(params.triggerBotUserId && params.triggerBotUserId === botUserId);
  if (isTriggerAgent) {
    fanoutLog(` ${accountId} is trigger agent — will skip round 1, join round 2+`);
  }

  // If we're in the middle of processing a round and this is a NEW message
  // (not the one being processed), queue it for after the current round.
  if (state.isProcessing && state.pendingRound?.triggerMessageId !== messageId) {
    // This is a new message arriving while a round is in progress.
    // Start collecting for a new round.
    startNewPendingRound(state, messageId, params);
    return true;
  }

  // If there's already a pending round for a DIFFERENT message, start fresh
  if (state.pendingRound && state.pendingRound.triggerMessageId !== messageId) {
    // Cancel old collection, start new
    if (state.pendingRound.collectionTimer) {
      clearTimeout(state.pendingRound.collectionTimer);
    }
    state.pendingRound = null;
  }

  if (!state.pendingRound) {
    startNewPendingRound(state, messageId, params);
  } else {
    // Add to existing pending round
    addRegistration(state.pendingRound, {
      accountId,
      botUserId,
      ctx,
      processMessage,
      skipFirstRound: isTriggerAgent,
    });
  }

  return true;
}

/**
 * Notify the coordinator that an agent has responded in a fan-out channel.
 * Called from reply delivery when a message is sent in a fan-out channel.
 */
export function notifyFanOutResponse(params: {
  channelId: string;
  accountId: string;
  responseText: string | undefined;
}): void {
  const state = channelStates.get(params.channelId);
  if (!state) {
    return;
  }

  const callback = state.responseCallbacks.get(params.accountId);
  if (callback) {
    state.responseCallbacks.delete(params.accountId);
    callback(params.responseText);
  }
}

/**
 * Check if a channel is currently in a fan-out round (for use in preflight gating).
 */
export function isFanOutRoundActive(channelId: string): boolean {
  const state = channelStates.get(channelId);
  return Boolean(state?.isProcessing);
}

// ── Internal ──

function startNewPendingRound(
  state: ChannelState,
  messageId: string,
  params: {
    accountId: string;
    botUserId: string;
    triggerBotUserId?: string;
    mentionedUserIds: string[];
    ctx: DiscordMessagePreflightContext;
    processMessage: (ctx: DiscordMessagePreflightContext) => Promise<void>;
  },
): void {
  const pending: PendingRound = {
    triggerMessageId: messageId,
    triggerAccountId: params.triggerBotUserId
      ? undefined // We use botUserId for self-exclusion, not accountId
      : undefined,
    registrations: [],
    collectionTimer: null,
    mentionedBotIds: params.mentionedUserIds,
  };

  const isSelfTrigger = Boolean(
    params.triggerBotUserId && params.triggerBotUserId === params.botUserId,
  );
  addRegistration(pending, {
    accountId: params.accountId,
    botUserId: params.botUserId,
    ctx: params.ctx,
    processMessage: params.processMessage,
    skipFirstRound: isSelfTrigger,
  });

  state.pendingRound = pending;

  // Start collection window — wait for other bots to register
  pending.collectionTimer = setTimeout(() => {
    pending.collectionTimer = null;
    void executeRound(state, pending);
  }, AGENT_COLLECTION_WINDOW_MS);
}

function addRegistration(pending: PendingRound, reg: AgentRegistration): void {
  // Deduplicate by accountId
  if (!pending.registrations.some((r) => r.accountId === reg.accountId)) {
    pending.registrations.push(reg);
  }
}

function orderAgents(
  registrations: AgentRegistration[],
  mentionedBotIds: string[],
  previousResponders: Set<string>,
  isFirstRound: boolean,
): AgentRegistration[] {
  if (isFirstRound) {
    // Mentioned agents first (in mention order), then rest random
    const mentioned: AgentRegistration[] = [];
    const rest: AgentRegistration[] = [];

    for (const reg of registrations) {
      if (mentionedBotIds.includes(reg.botUserId)) {
        mentioned.push(reg);
      } else {
        rest.push(reg);
      }
    }

    // Sort mentioned by their position in mentionedBotIds
    mentioned.sort(
      (a, b) => mentionedBotIds.indexOf(a.botUserId) - mentionedBotIds.indexOf(b.botUserId),
    );

    // Shuffle rest
    shuffleArray(rest);

    return [...mentioned, ...rest];
  } else {
    // Chained round: previous responders first, then rest random
    const responders: AgentRegistration[] = [];
    const rest: AgentRegistration[] = [];

    for (const reg of registrations) {
      if (previousResponders.has(reg.accountId)) {
        responders.push(reg);
      } else {
        rest.push(reg);
      }
    }

    shuffleArray(responders);
    shuffleArray(rest);

    return [...responders, ...rest];
  }
}

function shuffleArray<T>(arr: T[]): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

async function executeRound(state: ChannelState, pending: PendingRound): Promise<void> {
  if (state.isProcessing) {
    // Already processing — this pending round will be picked up after
    return;
  }

  state.isProcessing = true;
  state.pendingRound = null;
  state.currentRound++;

  const isFirstRound = state.currentRound === 1;
  const conv = state.conversation;

  // On first round, add the trigger message to the conversation log
  // (subsequent rounds are chained from bot responses which get added via notifyFanOutResponse)
  if (isFirstRound) {
    // Reset conversation state for a new conversation
    conv.messages = [];
    conv.watermarks.clear();
    conv.nextIndex = 0;

    // Add the triggering (human) message
    const triggerContent = pending.registrations[0]?.ctx?.messageText ?? "(trigger message)";
    conv.messages.push({
      agentId: "human",
      content: triggerContent,
      index: conv.nextIndex++,
    });
  }

  // Determine which agents have new messages and separate them
  const agentsWithNewMessages: AgentRegistration[] = [];
  const agentsWithoutNewMessages: AgentRegistration[] = [];

  for (const reg of pending.registrations) {
    const watermark = conv.watermarks.get(reg.accountId) ?? -1;
    const hasNew = conv.messages.some((m) => m.index > watermark);
    if (hasNew) {
      agentsWithNewMessages.push(reg);
    } else {
      agentsWithoutNewMessages.push(reg);
    }
  }

  // Order only agents that have new messages
  const ordered = orderAgents(
    agentsWithNewMessages,
    pending.mentionedBotIds,
    state.previousRoundResponders,
    isFirstRound,
  );

  logVerbose(
    `fanout: round ${state.currentRound} starting with ${ordered.length} agents (${agentsWithoutNewMessages.length} skipped, no new messages) (msg=${pending.triggerMessageId})`,
  );

  const results: RoundResult[] = [];

  // Record skipped agents
  for (const reg of agentsWithoutNewMessages) {
    results.push({
      accountId: reg.accountId,
      botUserId: reg.botUserId,
      responded: false,
      skipped: true,
    });
    fanoutLog(` round ${state.currentRound} → skip ${reg.accountId} (no new messages)`);
  }

  for (const reg of ordered) {
    // Skip trigger agent in round 1 — they sent the message, no need to echo it back
    if (reg.skipFirstRound && state.currentRound === 1) {
      fanoutLog(` round ${state.currentRound} → skip ${reg.accountId} (trigger agent, round 1)`);
      results.push({
        accountId: reg.accountId,
        botUserId: reg.botUserId,
        responded: false,
        skipped: true,
      });
      continue;
    }

    fanoutLog(` round ${state.currentRound} → agent ${reg.accountId}`);

    // Build context with only messages newer than this agent's watermark
    const watermark = conv.watermarks.get(reg.accountId) ?? -1;
    const newMessages = conv.messages.filter((m) => m.index > watermark);
    const accumulatedResponses = newMessages
      .filter((m) => m.agentId !== "human")
      .map((m) => `[${m.agentId}]: ${m.content}`);

    fanoutLog(
      `agent ${reg.accountId}: watermark=${watermark} newMessages=${newMessages.length} accumulated=${accumulatedResponses.length} convTotal=${conv.messages.length}`,
    );
    const modifiedCtx = buildAccumulatedContext(reg.ctx, accumulatedResponses, state.currentRound);

    // Update watermark BEFORE processing — agent now "sees" all current messages
    conv.watermarks.set(
      reg.accountId,
      conv.messages.length > 0 ? conv.messages[conv.messages.length - 1].index : -1,
    );

    // Create response promise
    const responsePromise = new Promise<string | undefined>((resolve) => {
      state.responseCallbacks.set(reg.accountId, resolve);

      // Timeout
      setTimeout(() => {
        if (state.responseCallbacks.has(reg.accountId)) {
          state.responseCallbacks.delete(reg.accountId);
          fanoutLog(` agent ${reg.accountId} timed out in round ${state.currentRound}`);
          resolve(undefined);
        }
      }, AGENT_RESPONSE_TIMEOUT_MS);
    });

    // Process the message for this agent
    try {
      await reg.processMessage(modifiedCtx);
    } catch (err) {
      fanoutLog(` agent ${reg.accountId} processing error: ${String(err)}`);
    }

    // Wait for response
    const responseText = await responsePromise;
    const responded = Boolean(responseText && !isSilentReplyText(responseText));
    fanoutLog(
      `agent ${reg.accountId} response: responded=${responded} text=${responseText?.substring(0, 80) ?? "(none)"}`,
    );

    results.push({
      accountId: reg.accountId,
      botUserId: reg.botUserId,
      responded,
      responseText: responded ? responseText : undefined,
    });

    if (responded && responseText) {
      // Add response to conversation log
      conv.messages.push({
        agentId: reg.accountId,
        content: responseText,
        index: conv.nextIndex++,
      });
      // Update this agent's watermark to include their own response
      conv.watermarks.set(reg.accountId, conv.messages[conv.messages.length - 1].index);
    }
  }

  // Round complete
  const anyResponded = results.some((r) => r.responded);
  state.previousRoundResponders = new Set(
    results.filter((r) => r.responded).map((r) => r.accountId),
  );

  const respondedCount = results.filter((r) => r.responded).length;
  const skippedCount = results.filter((r) => r.skipped).length;
  logVerbose(
    `fanout: round ${state.currentRound} complete. ${respondedCount} responded, ${skippedCount} skipped, ${results.length - respondedCount - skippedCount} NO_REPLY.`,
  );

  state.isProcessing = false;

  // Round chaining: if any agent responded and we haven't hit the limit, trigger another round
  fanoutLog(
    `round ${state.currentRound} decision: anyResponded=${anyResponded} limit=${state.roundLimit} pendingRound=${!!state.pendingRound}`,
  );
  if (anyResponded && state.currentRound < state.roundLimit) {
    // Check if a new pending round arrived while we were processing
    if (state.pendingRound) {
      void executeRound(state, state.pendingRound);
    } else {
      // No new Discord messages yet — schedule a continuation round with the same registrations
      // so agents who haven't seen the latest responses get a chance
      scheduleChainedRound(state, pending);
    }
  } else {
    if (state.currentRound >= state.roundLimit) {
      fanoutLog(` round limit (${state.roundLimit}) reached in channel`);
    }
    // Reset round counter — next external message starts fresh
    state.currentRound = 0;
    state.previousRoundResponders.clear();
    // Check if a new message arrived while we were processing
    if (state.pendingRound) {
      fanoutLog(` processing queued pending round after conversation ended`);
      void executeRound(state, state.pendingRound);
    }
  }
}

function scheduleChainedRound(state: ChannelState, previousPending: PendingRound): void {
  // Check if any agent still has unseen messages
  const conv = state.conversation;
  const hasAgentsWithNewMessages = previousPending.registrations.some((reg) => {
    const watermark = conv.watermarks.get(reg.accountId) ?? -1;
    return conv.messages.some((m) => m.index > watermark);
  });

  if (!hasAgentsWithNewMessages) {
    fanoutLog(` no agents have new messages, ending conversation`);
    state.currentRound = 0;
    state.previousRoundResponders.clear();
    if (state.pendingRound) {
      fanoutLog(` processing queued pending round after conversation ended`);
      void executeRound(state, state.pendingRound);
    }
    return;
  }

  // Create a new pending round with the same registrations for chained processing
  const chainedPending: PendingRound = {
    triggerMessageId: previousPending.triggerMessageId,
    triggerAccountId: previousPending.triggerAccountId,
    registrations: previousPending.registrations,
    collectionTimer: null,
    mentionedBotIds: previousPending.mentionedBotIds,
  };

  fanoutLog(` scheduling chained round`);
  void executeRound(state, chainedPending);
}

function buildAccumulatedContext(
  ctx: DiscordMessagePreflightContext,
  accumulatedResponses: string[],
  roundNumber: number,
): DiscordMessagePreflightContext {
  if (accumulatedResponses.length === 0) {
    // First agent in round — just add guidance
    const modifiedCtx = { ...ctx };
    // The guidance is already added for fan-out bot messages in process.ts
    // For human messages, we add it here
    if (!ctx.isFanOutBotMessage) {
      // We'll let process.ts handle the body construction, but store round info
      (modifiedCtx as DiscordMessagePreflightContext & { _fanOutRound?: number })._fanOutRound =
        roundNumber;
      (
        modifiedCtx as DiscordMessagePreflightContext & { _fanOutAccumulatedResponses?: string[] }
      )._fanOutAccumulatedResponses = [];
    }
    return modifiedCtx;
  }

  // Subsequent agents — include accumulated context
  const modifiedCtx = { ...ctx };
  (modifiedCtx as DiscordMessagePreflightContext & { _fanOutRound?: number })._fanOutRound =
    roundNumber;
  (
    modifiedCtx as DiscordMessagePreflightContext & { _fanOutAccumulatedResponses?: string[] }
  )._fanOutAccumulatedResponses = [...accumulatedResponses];

  return modifiedCtx;
}

/**
 * Get the fan-out round metadata from a context, if present.
 */
export function getFanOutRoundInfo(ctx: DiscordMessagePreflightContext): {
  round: number;
  accumulatedResponses: string[];
} | null {
  const round = (ctx as DiscordMessagePreflightContext & { _fanOutRound?: number })._fanOutRound;
  if (round === undefined) {
    return null;
  }

  const responses = (
    ctx as DiscordMessagePreflightContext & { _fanOutAccumulatedResponses?: string[] }
  )._fanOutAccumulatedResponses;

  return {
    round,
    accumulatedResponses: responses ?? [],
  };
}

export { FANOUT_GUIDANCE };
