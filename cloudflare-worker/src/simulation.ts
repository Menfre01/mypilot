import type { SSEHookEvent, SessionInfo, SESSION_COLORS } from './protocol';

const COLORS = ['#89b4fa', '#a6e3a1', '#f38ba8', '#f9e2af', '#b4befe', '#89dceb', '#fab387', '#cba6f7'];

export interface SimStep {
  delay: number; // ms after previous step
  action: 'start_session' | 'end_session' | 'event' | 'block';
  sessionId?: string;
  event?: Omit<SSEHookEvent, 'event_id'>;
}

export interface SimSession {
  id: string;
  colorIndex: number;
}

const S1: SimSession = { id: '6417e43a-ff2c-4220-a6dd-4af696d190c6', colorIndex: 0 };
const S2: SimSession = { id: 'e2166cb5-ec67-4d38-9395-4422a9db270f', colorIndex: 1 };
const S3: SimSession = { id: '068bd86a-c7e0-4f4a-817b-c7e35a08f614', colorIndex: 2 };

const now = () => Date.now();
let seq = 0;

function nextEventId(): string {
  return (seq++).toString(36);
}

function resetSeq() {
  seq = 0;
}

export function getSessions(): SimSession[] {
  return [S1, S2, S3];
}

export function toSessionInfo(s: SimSession): SessionInfo & { startedAt: number } {
  return {
    id: s.id,
    color: COLORS[s.colorIndex],
    colorIndex: s.colorIndex,
    startedAt: now(),
  };
}

// ── Build the demo script ──

export function buildDemoScript(): SimStep[] {
  resetSeq();
  const ts = () => now();
  const script: SimStep[] = [];

  // Session 1: Refactoring auth (Explorer card + tools)
  script.push({ delay: 2000, action: 'start_session', sessionId: S1.id });

  // User prompt (first message in session)
  script.push({ delay: 500, action: 'event', sessionId: S1.id, event: { session_id: S1.id, event_name: 'UserPromptSubmit', prompt: 'Refactor the auth module to use RS256 algorithm and ensure all tests pass', timestamp: ts() } });

  // Explorer card: Glob → Grep → Read
  script.push({ delay: 1000, action: 'event', sessionId: S1.id, event: { session_id: S1.id, event_name: 'PreToolUse', tool_name: 'Glob', tool_input: { pattern: 'src/**/*auth*.{ts,js}' }, tool_use_id: 'call_001', timestamp: ts() } });
  script.push({ delay: 2000, action: 'event', sessionId: S1.id, event: { session_id: S1.id, event_name: 'PostToolUse', tool_name: 'Glob', tool_input: { pattern: 'src/**/*auth*.{ts,js}' }, tool_result: 'src/auth/login.ts\nsrc/auth/logout.ts\nsrc/auth/middleware.ts\nsrc/auth/types.ts', tool_use_id: 'call_001', timestamp: ts() } });
  script.push({ delay: 1000, action: 'event', sessionId: S1.id, event: { session_id: S1.id, event_name: 'PreToolUse', tool_name: 'Grep', tool_input: { pattern: 'validateToken', path: 'src/auth' }, tool_use_id: 'call_002', timestamp: ts() } });
  script.push({ delay: 1500, action: 'event', sessionId: S1.id, event: { session_id: S1.id, event_name: 'PostToolUse', tool_name: 'Grep', tool_input: { pattern: 'validateToken', path: 'src/auth' }, tool_result: 'src/auth/middleware.ts:15:export async function validateToken(token: string)', tool_use_id: 'call_002', timestamp: ts() } });
  script.push({ delay: 800, action: 'event', sessionId: S1.id, event: { session_id: S1.id, event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: 'src/auth/middleware.ts' }, tool_use_id: 'call_003', timestamp: ts() } });
  script.push({ delay: 2000, action: 'event', sessionId: S1.id, event: { session_id: S1.id, event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: 'src/auth/middleware.ts' }, tool_result: 'export async function validateToken(token: string): Promise<User> {\n  const decoded = jwt.verify(token, SECRET);\n  return decoded;\n}', tool_use_id: 'call_003', timestamp: ts() } });

  // Bash tool
  script.push({ delay: 1000, action: 'event', sessionId: S1.id, event: { session_id: S1.id, event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npm test -- --grep auth', description: 'Run auth tests' }, tool_use_id: 'call_004', timestamp: ts() } });
  script.push({ delay: 3000, action: 'event', sessionId: S1.id, event: { session_id: S1.id, event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'npm test -- --grep auth' }, tool_result: 'PASS src/auth/login.test.ts (2.1s)\n  ✓ should validate token correctly\n  ✓ should reject expired tokens\n\nTests: 2 passed, 2 total', tool_use_id: 'call_004', timestamp: ts() } });

  // Edit tool
  script.push({ delay: 1000, action: 'event', sessionId: S1.id, event: { session_id: S1.id, event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: 'src/auth/middleware.ts', old_string: 'const decoded = jwt.verify(token, SECRET);', new_string: 'const decoded = jwt.verify(token, SECRET, { algorithms: [\'HS256\'] });' }, tool_use_id: 'call_005', timestamp: ts() } });
  script.push({ delay: 1500, action: 'event', sessionId: S1.id, event: { session_id: S1.id, event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: 'src/auth/middleware.ts' }, tool_result: 'Successfully edited src/auth/middleware.ts', tool_use_id: 'call_005', timestamp: ts() } });

  // Write tool
  script.push({ delay: 800, action: 'event', sessionId: S1.id, event: { session_id: S1.id, event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: 'src/auth/constants.ts', content: 'export const TOKEN_EXPIRY = \'24h\';\nexport const REFRESH_EXPIRY = \'7d\';\n' }, tool_use_id: 'call_006', timestamp: ts() } });
  script.push({ delay: 1200, action: 'event', sessionId: S1.id, event: { session_id: S1.id, event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: 'src/auth/constants.ts' }, tool_result: 'Successfully wrote src/auth/constants.ts', tool_use_id: 'call_006', timestamp: ts() } });

  // Notification
  script.push({ delay: 1000, action: 'event', sessionId: S1.id, event: { session_id: S1.id, event_name: 'Notification', message: 'All auth tests passing after refactoring', title: 'Tests Passed', timestamp: ts() } });

  // Tool failure
  script.push({ delay: 1500, action: 'event', sessionId: S1.id, event: { session_id: S1.id, event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npm run lint', description: 'Run linter' }, tool_use_id: 'call_007', timestamp: ts() } });
  script.push({ delay: 2000, action: 'event', sessionId: S1.id, event: { session_id: S1.id, event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_input: { command: 'npm run lint' }, tool_result: 'src/auth/middleware.ts:16:5 - error TS2322: Type \'string\' is not assignable to type \'User\'.', tool_use_id: 'call_007', timestamp: ts() } });

  // Compact messages
  script.push({ delay: 1000, action: 'event', sessionId: S1.id, event: { session_id: S1.id, event_name: 'PreCompact', message: 'Compacting conversation to save context window...', timestamp: ts() } });
  script.push({ delay: 1500, action: 'event', sessionId: S1.id, event: { session_id: S1.id, event_name: 'PostCompact', message: 'Compacted 47 messages to 12', timestamp: ts() } });

  // Second user prompt after compact
  script.push({ delay: 500, action: 'event', sessionId: S1.id, event: { session_id: S1.id, event_name: 'UserPromptSubmit', prompt: 'Fix the type error in middleware and run tests again', timestamp: ts() } });

  // Fix the error
  script.push({ delay: 1000, action: 'event', sessionId: S1.id, event: { session_id: S1.id, event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: 'src/auth/middleware.ts', old_string: 'return decoded;', new_string: 'return decoded as User;' }, tool_use_id: 'call_008', timestamp: ts() } });
  script.push({ delay: 1000, action: 'event', sessionId: S1.id, event: { session_id: S1.id, event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: 'src/auth/middleware.ts' }, tool_result: 'Successfully edited src/auth/middleware.ts', tool_use_id: 'call_008', timestamp: ts() } });
  script.push({ delay: 800, action: 'event', sessionId: S1.id, event: { session_id: S1.id, event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npm test', description: 'Run all tests' }, tool_use_id: 'call_009', timestamp: ts() } });
  script.push({ delay: 2500, action: 'event', sessionId: S1.id, event: { session_id: S1.id, event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_result: 'PASS src/auth/login.test.ts (2.1s)\nPASS src/auth/middleware.test.ts (1.8s)\n\nTests: 4 passed, 4 total\nAll tests passed!', tool_use_id: 'call_009', timestamp: ts() } });

  // Session 2: Payment tests with subagent
  script.push({ delay: 2000, action: 'start_session', sessionId: S2.id });
  script.push({ delay: 500, action: 'event', sessionId: S2.id, event: { session_id: S2.id, event_name: 'UserPromptSubmit', prompt: 'Add comprehensive tests for the payment service', timestamp: ts() } });
  script.push({ delay: 1000, action: 'event', sessionId: S2.id, event: { session_id: S2.id, event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: 'src/payment/stripe.ts' }, tool_use_id: 'call_010', timestamp: ts() } });
  script.push({ delay: 2000, action: 'event', sessionId: S2.id, event: { session_id: S2.id, event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: 'src/payment/stripe.ts' }, tool_result: '// Stripe payment integration\nexport async function createCharge(amount: number, currency: string) {\n  return stripe.charges.create({ amount, currency });\n}', tool_use_id: 'call_010', timestamp: ts() } });

  // Agent call
  script.push({ delay: 1000, action: 'event', sessionId: S2.id, event: { session_id: S2.id, event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { description: 'Write comprehensive tests for payment module' }, tool_use_id: 'call_011', timestamp: ts() } });
  script.push({ delay: 500, action: 'event', sessionId: S2.id, event: { session_id: S2.id, event_name: 'SubagentStart', agent_id: 'agent-001', timestamp: ts() } });

  // Subagent child events
  script.push({ delay: 1500, action: 'event', sessionId: S2.id, event: { session_id: S2.id, event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: 'src/payment/stripe.ts' }, tool_use_id: 'call_012', agent_id: 'agent-001', timestamp: ts() } });
  script.push({ delay: 1500, action: 'event', sessionId: S2.id, event: { session_id: S2.id, event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: 'src/payment/stripe.ts' }, tool_result: '// ... file content ...', tool_use_id: 'call_012', agent_id: 'agent-001', timestamp: ts() } });
  script.push({ delay: 800, action: 'event', sessionId: S2.id, event: { session_id: S2.id, event_name: 'PreToolUse', tool_name: 'Glob', tool_input: { pattern: 'test/payment/**/*.test.ts' }, tool_use_id: 'call_013', agent_id: 'agent-001', timestamp: ts() } });
  script.push({ delay: 1000, action: 'event', sessionId: S2.id, event: { session_id: S2.id, event_name: 'PostToolUse', tool_name: 'Glob', tool_result: 'test/payment/stripe.test.ts', tool_use_id: 'call_013', agent_id: 'agent-001', timestamp: ts() } });
  script.push({ delay: 1000, action: 'event', sessionId: S2.id, event: { session_id: S2.id, event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: 'test/payment/stripe.test.ts', content: 'import { createCharge } from \'../src/payment/stripe\';\n\ndescribe(\'Payment\', () => {\n  it(\'should create charge\', async () => {\n    const result = await createCharge(1000, \'usd\');\n    expect(result).toBeDefined();\n  });\n});' }, tool_use_id: 'call_014', agent_id: 'agent-001', timestamp: ts() } });
  script.push({ delay: 2000, action: 'event', sessionId: S2.id, event: { session_id: S2.id, event_name: 'PostToolUse', tool_name: 'Write', tool_result: 'Wrote test/payment/stripe.test.ts', tool_use_id: 'call_014', agent_id: 'agent-001', timestamp: ts() } });
  script.push({ delay: 1000, action: 'event', sessionId: S2.id, event: { session_id: S2.id, event_name: 'SubagentStop', agent_id: 'agent-001', timestamp: ts() } });
  script.push({ delay: 500, action: 'event', sessionId: S2.id, event: { session_id: S2.id, event_name: 'PostToolUse', tool_name: 'Agent', tool_result: 'Created comprehensive test suite for payment module', tool_use_id: 'call_011', timestamp: ts() } });
  script.push({ delay: 500, action: 'event', sessionId: S2.id, event: { session_id: S2.id, event_name: 'Notification', message: 'Test coverage increased to 87%', title: 'Coverage Update', timestamp: ts() } });

  // Task events (shown in TaskPanel) — create tasks, transition through states, complete
  script.push({ delay: 500, action: 'event', sessionId: S2.id, event: { session_id: S2.id, event_name: 'TaskCreated', task_id: 'task-run-tests', tool_use_id: 'call_015', task_subject: 'Run payment integration tests', task_description: 'Execute the full payment integration test suite and report results', timestamp: ts() } });
  script.push({ delay: 1500, action: 'event', sessionId: S2.id, event: { session_id: S2.id, event_name: 'TaskCreated', task_id: 'task-lint', tool_use_id: 'call_016', task_subject: 'Lint payment module code', task_description: 'Run ESLint on all payment-related files', timestamp: ts() } });
  // Transition to in_progress
  script.push({ delay: 2000, action: 'event', sessionId: S2.id, event: { session_id: S2.id, event_name: 'PreToolUse', tool_name: 'TaskUpdate', tool_input: { taskId: 'task-run-tests', status: 'in_progress' }, tool_use_id: 'call_018', timestamp: ts() } });
  script.push({ delay: 1500, action: 'event', sessionId: S2.id, event: { session_id: S2.id, event_name: 'PreToolUse', tool_name: 'TaskUpdate', tool_input: { taskId: 'task-lint', status: 'in_progress' }, tool_use_id: 'call_019', timestamp: ts() } });
  // Complete tasks
  script.push({ delay: 2000, action: 'event', sessionId: S2.id, event: { session_id: S2.id, event_name: 'TaskCompleted', task_id: 'task-lint', tool_use_id: 'call_016', result: 'No linting errors found', timestamp: ts() } });
  script.push({ delay: 1500, action: 'event', sessionId: S2.id, event: { session_id: S2.id, event_name: 'TaskCompleted', task_id: 'task-run-tests', tool_use_id: 'call_015', result: 'All 5 integration tests passed', timestamp: ts() } });

  // Session 3: Deploy monitoring
  script.push({ delay: 1500, action: 'start_session', sessionId: S3.id });
  script.push({ delay: 500, action: 'event', sessionId: S3.id, event: { session_id: S3.id, event_name: 'UserPromptSubmit', prompt: 'Deploy the monitoring dashboard to staging', timestamp: ts() } });
  script.push({ delay: 1000, action: 'event', sessionId: S3.id, event: { session_id: S3.id, event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: 'deploy/monitoring.yaml' }, tool_use_id: 'call_020', timestamp: ts() } });
  script.push({ delay: 1500, action: 'event', sessionId: S3.id, event: { session_id: S3.id, event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: 'deploy/monitoring.yaml' }, tool_result: 'apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: grafana\n  namespace: monitoring', tool_use_id: 'call_020', timestamp: ts() } });

  // PermissionRequest blocking event
  script.push({ delay: 2000, action: 'block', sessionId: S3.id, event: { session_id: S3.id, event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'kubectl apply -f deploy/monitoring.yaml', description: 'Deploy monitoring stack to Kubernetes' }, tool_use_id: 'call_021', message: 'Allow running: kubectl apply -f deploy/monitoring.yaml', timestamp: ts() } });

  // After PermissionRequest resolved
  script.push({ delay: 500, action: 'event', sessionId: S3.id, event: { session_id: S3.id, event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'kubectl apply -f deploy/monitoring.yaml' }, tool_use_id: 'call_021', timestamp: ts() } });
  script.push({ delay: 3000, action: 'event', sessionId: S3.id, event: { session_id: S3.id, event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'kubectl apply -f deploy/monitoring.yaml' }, tool_result: 'namespace/monitoring created\ndeployment.apps/grafana created\ndeployment.apps/prometheus created', tool_use_id: 'call_021', timestamp: ts() } });

  // AskUserQuestion blocking event (Session 3)
  script.push({ delay: 1000, action: 'block', sessionId: S3.id, event: { session_id: S3.id, event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: 'Which environment should I deploy to?', options: [{ label: 'Staging', description: 'Deploy to staging for QA testing' }, { label: 'Production', description: 'Deploy to production environment' }] }], multipleSelect: false }, tool_use_id: 'call_022', timestamp: ts() } });

  // Elicitation blocking event (Session 2)
  script.push({ delay: 2000, action: 'block', sessionId: S2.id, event: { session_id: S2.id, event_name: 'Elicitation', message: 'Should I also add integration tests for the webhook handler?', tool_name: 'Elicitation', timestamp: ts() } });

  // End session 1
  script.push({ delay: 2000, action: 'end_session', sessionId: S1.id });

  // Stop blocking event (Session 3)
  script.push({ delay: 2000, action: 'block', sessionId: S3.id, event: { session_id: S3.id, event_name: 'Stop', reason: 'Deployment complete. Would you like me to continue setting up alerts?', timestamp: ts() } });

  // End remaining sessions
  script.push({ delay: 2000, action: 'end_session', sessionId: S2.id });
  script.push({ delay: 2000, action: 'end_session', sessionId: S3.id });

  return script;
}

// ── Simulation Scheduler ──

export type SendCallback = (msg: SimStep & { event?: SSEHookEvent }) => void;

export class SimulationScheduler {
  private script: SimStep[] = [];
  private position = 0;
  private timers: ReturnType<typeof setTimeout>[] = [];
  private running = false;
  private blocked = false;
  private scriptId = 0;
  private sendCb: SendCallback | null = null;
  private onSessionStart: ((sessionId: string) => void) | null = null;
  private onSessionEnd: ((sessionId: string) => void) | null = null;

  constructor(
    sendCb: SendCallback,
    onSessionStart: (sessionId: string) => void,
    onSessionEnd: (sessionId: string) => void,
  ) {
    this.sendCb = sendCb;
    this.onSessionStart = onSessionStart;
    this.onSessionEnd = onSessionEnd;
  }

  start() {
    this.script = buildDemoScript();
    this.position = 0;
    this.running = true;
    this.blocked = false;
    this.scriptId++;
    this.scheduleNext();
  }

  stop() {
    this.running = false;
    this.scriptId++;
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }

  isRunning() {
    return this.running;
  }

  resolveBlocking(eventId: string) {
    if (!this.blocked) return;
    this.blocked = false;
    this.scheduleNext();
  }

  private scheduleNext() {
    if (!this.running || this.blocked) return;
    if (this.position >= this.script.length) {
      // Loop: restart after 3s
      const id = this.scriptId;
      const t = setTimeout(() => {
        if (this.scriptId !== id) return;
        this.start();
      }, 3000);
      this.timers.push(t);
      return;
    }

    const step = this.script[this.position++];
    const id = this.scriptId;

    const t = setTimeout(() => {
      if (this.scriptId !== id) return;
      this.executeStep(step);
    }, step.delay);
    this.timers.push(t);
  }

  private executeStep(step: SimStep) {
    if (!this.running) return;

    switch (step.action) {
      case 'start_session':
        this.onSessionStart?.(step.sessionId!);
        this.scheduleNext();
        break;
      case 'end_session':
        this.onSessionEnd?.(step.sessionId!);
        this.scheduleNext();
        break;
      case 'event': {
        // Assign event_id
        const evt = {
          ...step.event!,
          event_id: nextEventId(),
        } as SSEHookEvent;
        this.sendCb?.({ ...step, event: evt });
        this.scheduleNext();
        break;
      }
      case 'block': {
        const blockEvt = {
          ...step.event!,
          event_id: nextEventId(),
        } as SSEHookEvent;
        this.sendCb?.({ ...step, event: blockEvt });
        this.blocked = true;
        // Auto-resolve after 30s
        const id = this.scriptId;
        const t = setTimeout(() => {
          if (this.scriptId !== id || !this.blocked) return;
          this.resolveBlocking(blockEvt.event_id);
        }, 30000);
        this.timers.push(t);
        break;
      }
    }
  }
}
