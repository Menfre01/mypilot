export type Locale = 'en' | 'zh-CN';

export type MessageKey =
  | 'permissionRequest'
  | 'stopRequest'
  | 'question'
  | 'planReview'
  | 'approvalNeeded'
  | 'wantsToUse'
  | 'wantsToStop'
  | 'hasAQuestion'
  | 'wantsToExitPlanMode'
  | 'myPilot'
  | 'newInteractionEvent';

export const translations: Record<MessageKey, Record<Locale, string>> = {
  permissionRequest:   { en: 'Permission Request',          'zh-CN': '权限请求' },
  stopRequest:         { en: 'Stop Request',                'zh-CN': '停止请求' },
  question:            { en: 'Question',                    'zh-CN': '问题' },
  planReview:          { en: 'Plan Review',                 'zh-CN': '计划审查' },
  approvalNeeded:      { en: 'Approval Needed',             'zh-CN': '需要审批' },
  wantsToUse:          { en: 'Claude wants to use {tool}',  'zh-CN': '请求使用 {tool}' },
  wantsToStop:         { en: 'Claude wants to stop',        'zh-CN': 'Claude 请求停止' },
  hasAQuestion:        { en: 'Claude has a question',       'zh-CN': 'Claude 有问题' },
  wantsToExitPlanMode: { en: 'Claude wants to exit plan mode', 'zh-CN': 'Claude 请求退出计划模式' },
  myPilot:             { en: 'MyPilot',                     'zh-CN': 'MyPilot' },
  newInteractionEvent: { en: 'New interaction event',       'zh-CN': '新交互事件' },
};

export function t(key: MessageKey, locale?: string, params?: Record<string, string>): string {
  const loc: Locale = locale === 'zh-CN' ? 'zh-CN' : 'en';
  let text = translations[key][loc];
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      text = text.replaceAll(`{${k}}`, v);
    }
  }
  return text;
}
