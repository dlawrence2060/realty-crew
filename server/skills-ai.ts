import fs from 'node:fs';
import path from 'node:path';
import { query, tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { LIBRARY_DIR, OWNER, SKILLS_DIR } from './config.ts';
import { agentEnv } from './env.ts';
import { getAgent, listSkills, setAgentSkills } from './roster.ts';

/**
 * The "skills assistant" in an agent's panel. The owner asks in plain words
 * ("give the brochure agent a skill for our feature-sheet layout");
 * Claude enables or disables library skills, or writes a new SKILL.md grounded
 * in the library and enables it.
 */
export async function skillsAssistant(agentId: string, request: string): Promise<{ summary: string; skills: string[]; created: string[] }> {
  const agent = getAgent(agentId);
  if (!agent) throw new Error(`No agent ${agentId}`);
  const created: string[] = [];

  const crew = createSdkMcpServer({
    name: 'skills',
    version: '0.1.0',
    alwaysLoad: true,
    tools: [
      tool(
        'set_skills',
        "Replace this agent's enabled skill list. Use names from the library or the built-ins.",
        { skills: z.array(z.string()) },
        async ({ skills }) => {
          const known = new Set(listSkills().map((s) => s.name));
          const unknown = skills.filter((s) => !known.has(s));
          if (unknown.length) return { content: [{ type: 'text', text: `Unknown skills: ${unknown.join(', ')}. Create them first.` }], isError: true };
          setAgentSkills(agentId, skills);
          return { content: [{ type: 'text', text: `${agent.name} now has: ${skills.join(', ') || '(none)'}` }] };
        },
      ),
    ],
  });

  const library = listSkills().map((s) => `- ${s.name} (${s.source}): ${s.description}`).join('\n');
  const append = `You manage skills for a BC real estate crew of AI agents. A skill is a SKILL.md file with YAML frontmatter (name, description) and markdown instructions; the description decides when the agent loads it, so make it specific about when to use it.

Agent: ${agent.name} (${agent.title}), id ${agent.id}, team ${agent.team ?? 'none'}.
Role: ${agent.description}
Enabled skills now: ${agent.skills.join(', ') || '(none)'}

Skill library (${SKILLS_DIR}) and built-ins:
${library}

Do what ${OWNER} asks:
- To add or remove existing skills, call set_skills with the full new list.
- To make a new skill, read the relevant material in the library at ${LIBRARY_DIR} first (brand guide, past work, forms) so it reflects how this brokerage actually works, then write ${SKILLS_DIR}/<kebab-name>/SKILL.md (frontmatter name must equal the folder name). Keep it tight: when to use it, the rules, concrete examples. Then enable it with set_skills.
- Don't delete skill files or edit other skills unless asked.
Finish with two or three sentences saying what changed.`;

  const before = new Set(fs.existsSync(SKILLS_DIR) ? fs.readdirSync(SKILLS_DIR) : []);
  let summary = '';
  for await (const msg of query({
    prompt: request,
    options: {
      cwd: LIBRARY_DIR,
      model: 'opus',
      effort: 'high',
      maxTurns: 40,
      maxBudgetUsd: 3,
      tools: ['Read', 'Glob', 'Grep', 'Write', 'Edit'],
      systemPrompt: { type: 'preset', preset: 'claude_code', append },
      settingSources: [],
      persistSession: false,
      mcpServers: { skills: crew },
      allowedTools: ['mcp__skills__set_skills'],
      permissionMode: 'default',
      canUseTool: async (name, input) => {
        if (['Read', 'Glob', 'Grep'].includes(name) || name === 'mcp__skills__set_skills') return { behavior: 'allow', updatedInput: input };
        const file = path.resolve(String(input.file_path ?? ''));
        if ((name === 'Write' || name === 'Edit') && file.startsWith(SKILLS_DIR + path.sep)) return { behavior: 'allow', updatedInput: input };
        return { behavior: 'deny', message: `Only files under ${SKILLS_DIR} can be written.` };
      },
      env: agentEnv(),
    },
  })) {
    if (msg.type === 'result' && msg.subtype === 'success') summary = msg.result;
  }
  for (const d of fs.readdirSync(SKILLS_DIR)) {
    if (before.has(d)) continue;
    created.push(d);
    fs.writeFileSync(path.join(SKILLS_DIR, d, '.source.json'), JSON.stringify({ from: 'ai', request, importedAt: new Date().toISOString() }, null, 2) + '\n');
  }
  return { summary: summary || 'Done.', skills: getAgent(agentId)?.skills ?? [], created };
}
