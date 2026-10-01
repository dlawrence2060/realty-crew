import { query } from '@anthropic-ai/claude-agent-sdk';
import { LIBRARY_DIR, OWNER, SKILLS_PLUGIN_DIR } from './config.ts';
import type { Task } from './db.ts';
import { agentEnv } from './env.ts';
import { GROUND_RULES } from './runner.ts';
import { getAgent, readMemory, sdkSkillIds, type AgentDef } from './roster.ts';

/**
 * ask_teammate: a short, read-only run of another agent that answers one
 * question from its own expertise and memory. It doesn't take the teammate's
 * work slot and can't change anything.
 */
// A consultation is another Claude Code process; keep them to one at a time so the droplet
// never has more than the running agents plus one helper.
let consultChain: Promise<unknown> = Promise.resolve();

export function consult(agentId: string, question: string, asker: AgentDef, task: Task): Promise<{ answer: string; cost: number }> {
  const run = consultChain.then(() => consultNow(agentId, question, asker, task));
  consultChain = run.catch(() => {});
  return run;
}

async function consultNow(agentId: string, question: string, asker: AgentDef, task: Task): Promise<{ answer: string; cost: number }> {
  const mate = getAgent(agentId);
  if (!mate) throw new Error(`No agent ${agentId}`);
  const append = [
    `You are ${mate.name}, ${mate.title} on ${OWNER}'s real estate crew.`,
    mate.instructions,
    GROUND_RULES,
    `## Your memory\n${readMemory(mate.id).trim() || '(empty)'}`,
    `## Right now
${asker.name} (${asker.title}) is working on "${task.title}" and is asking you a question about your area.
Answer like a senior colleague in a quick chat: direct, specific, short. Check the library before answering when it could hold the answer. You can't edit anything. If it's not your area, say whose it is.`,
  ].join('\n\n');

  let answer = '';
  let cost = 0;
  const READ = ['Read', 'Glob', 'Grep', 'Skill', 'WebSearch', 'WebFetch'];
  for await (const msg of query({
    prompt: question,
    options: {
      cwd: LIBRARY_DIR,
      model: mate.model,
      effort: 'medium',
      maxTurns: 25,
      maxBudgetUsd: 2,
      tools: READ,
      systemPrompt: { type: 'preset', preset: 'claude_code', append },
      settingSources: [],
      plugins: [{ type: 'local', path: SKILLS_PLUGIN_DIR }],
      skills: sdkSkillIds(mate),
      persistSession: false,
      permissionMode: 'default',
      canUseTool: async (name, input) =>
        READ.includes(name) ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: 'Consultations are read-only.' },
      env: agentEnv(),
    },
  })) {
    if (msg.type === 'result') {
      cost = msg.total_cost_usd ?? 0;
      if (msg.subtype === 'success') answer = msg.result;
    }
  }
  if (!answer.trim()) throw new Error('no answer');
  return { answer, cost };
}
