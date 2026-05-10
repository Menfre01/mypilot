import type { RewindTurn } from '../../shared/protocol.js';
import type { ClaudeProcessManager } from './claude-process-manager.js';
import type { WsBus } from './ws-bus.js';

interface ActiveInterception {
  sessionId: string;
  interactionId: string;
  deviceId: string;
  turns: RewindTurn[];
  timeoutTimer?: ReturnType<typeof setTimeout>;
}

export class PtyCommandInterceptor {
  private activeInterceptions = new Map<string, ActiveInterception>();

  /** 发送结构化 rewind 选择器到手机端（turns 从 transcript 预计算） */
  sendRewindSelector(
    sessionId: string,
    turns: RewindTurn[],
    wsBus: WsBus,
    deviceId: string,
  ): void {
    this.cleanup(sessionId);

    if (turns.length === 0) return;

    const interactionId = `${sessionId}-rewind-${Date.now()}`;

    const interception: ActiveInterception = {
      sessionId,
      interactionId,
      deviceId,
      turns,
    };

    // 10 秒超时
    interception.timeoutTimer = setTimeout(() => {
      this.cleanup(sessionId);
    }, 10_000);

    this.activeInterceptions.set(sessionId, interception);

    wsBus.broadcast(
      {
        type: 'rewind_selector',
        interactionId,
        sessionId,
        turns,
      },
      deviceId,
    );
  }

  handleRewindSelect(
    sessionId: string,
    interactionId: string,
    turnIndex: number,
    processManager: ClaudeProcessManager,
  ): void {
    const interception = this.activeInterceptions.get(sessionId);
    if (!interception || interception.interactionId !== interactionId) return;

    // 先发送 /rewind 到 PTY 触发 TUI
    processManager.write(sessionId, '\x03'); // Ctrl+C 确保在命令模式
    processManager.write(sessionId, '/rewind');
    processManager.write(sessionId, '\r');

    // TUI 渲染后（第一项默认选中），用下箭头导航到目标项
    if (turnIndex > 0) {
      // 短暂延迟等 TUI 渲染完成再注入方向键
      setTimeout(() => {
        for (let i = 0; i < turnIndex; i++) {
          processManager.write(sessionId, '\x1b[B'); // 下箭头
        }
        processManager.write(sessionId, '\r'); // 回车确认
      }, 600);
    } else {
      // turnIndex === 0，默认已选中第一项，直接回车
      setTimeout(() => {
        processManager.write(sessionId, '\r');
      }, 600);
    }

    this.cleanup(sessionId);
  }

  handleRewindCancel(sessionId: string, interactionId: string): void {
    const interception = this.activeInterceptions.get(sessionId);
    if (!interception || interception.interactionId !== interactionId) return;

    this.cleanup(sessionId);
  }

  cleanup(sessionId: string): void {
    const interception = this.activeInterceptions.get(sessionId);
    if (!interception) return;

    if (interception.timeoutTimer) clearTimeout(interception.timeoutTimer);
    this.activeInterceptions.delete(sessionId);
  }
}
