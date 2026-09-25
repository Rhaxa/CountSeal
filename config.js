// config.js — central settings.
// This is the ONLY file we edit when a provider's website changes.

export const SENTINEL = '[[END_7f3a]]';

export const SENTINEL_PROMPT = `End every response with exactly ${SENTINEL} on its own line, followed by exactly one status line:
- [[STATUS: IN_PROGRESS]]
- [[STATUS: DONE]]
- [[STATUS: BLOCKED: <one-line reason>]]
Do not use these tokens anywhere else. Do not explain them.`;

// Each provider drives one role. Object order = speaking order in the round-robin.
export const PROVIDERS = {
  deepseek: {
    label: 'DeepSeek',
    role: 'Product Owner',
    startUrl: 'https://chat.deepseek.com',
    input: 'textarea',
    sendButton: 'button[aria-label*="send" i]',
    messages: '[class*="message"]',
  },
  kimi: {
    label: 'Kimi',
    role: 'Technical Lead',
    startUrl: 'https://www.kimi.ai',
    input: 'textarea, [contenteditable="true"]',
    sendButton: 'button:has-text("Send")',
    messages: '.segment-container',
  },
  qwen: {
    label: 'Qwen',
    role: 'QA',
    startUrl: 'https://chat.qwen.ai',
    input: 'textarea',
    sendButton: 'button:has-text("Send")',
    messages: '.qwen-chat-message-assistant',
    errorText: 'issue connecting',
  },
};

export const ROLE_CARDS = {
  'Product Owner': `You articulate the vision, define success criteria, and keep the team aligned with the original goal. You do not write code or handle implementation details unless explicitly asked. You may mark DONE only when every DoD item is satisfied. Marking DONE is a commitment, not a suggestion.`,
  'Technical Lead': `You translate the Project Owner's vision into a concrete technical plan, flag constraints, and propose implementation steps. You do not override the vision unless you identify a fundamental impossibility. You may mark DONE only when the plan satisfies every DoD item. You may revoke DONE if a later turn reveals a gap.`,
  'QA': `You verify that the Project Owner and Technical Lead remain on-topic and compliant with the frozen DoD. If you detect drift, call it out explicitly. You do not introduce new requirements. You are the last line of defense against premature DONE. If you revoke DONE, cite the specific DoD item that is unmet.`,
};

export const ROLE_REMINDERS = {
  'Product Owner': 'You are the Project Owner: vision and success criteria only, no implementation details.',
  'Technical Lead': 'You are the Technical Lead: concrete plans and constraints; you may revoke DONE if a gap appears.',
  'QA': 'You are the QA: verify compliance with the frozen DoD; call out drift; no new requirements.',
};