import { describe, it, expect } from 'vitest';
import { t, translations, type Locale } from './i18n.js';

describe('i18n', () => {
  it('returns English by default', () => {
    expect(t('permissionRequest')).toBe('Permission Request');
    expect(t('wantsToStop')).toBe('Claude wants to stop');
  });

  it('returns English for explicit en locale', () => {
    expect(t('question', 'en')).toBe('Question');
    expect(t('myPilot', 'en')).toBe('MyPilot');
  });

  it('returns Chinese for zh-CN locale', () => {
    expect(t('permissionRequest', 'zh-CN')).toBe('权限请求');
    expect(t('stopRequest', 'zh-CN')).toBe('停止请求');
    expect(t('question', 'zh-CN')).toBe('问题');
    expect(t('planReview', 'zh-CN')).toBe('计划审查');
    expect(t('wantsToStop', 'zh-CN')).toBe('Claude 请求停止');
    expect(t('hasAQuestion', 'zh-CN')).toBe('Claude 有问题');
    expect(t('newInteractionEvent', 'zh-CN')).toBe('新交互事件');
  });

  it('falls back to English for unknown locale', () => {
    expect(t('permissionRequest', 'fr')).toBe('Permission Request');
    expect(t('permissionRequest', 'ja')).toBe('Permission Request');
  });

  it('substitutes template params', () => {
    expect(t('wantsToUse', 'en', { tool: 'Bash' })).toBe('Claude wants to use Bash');
    expect(t('wantsToUse', 'zh-CN', { tool: 'Bash' })).toBe('请求使用 Bash');
  });

  it('returns MyPilot unchanged in both locales', () => {
    expect(t('myPilot', 'en')).toBe('MyPilot');
    expect(t('myPilot', 'zh-CN')).toBe('MyPilot');
  });

  it('covers all MessageKeys in both locales', () => {
    const keys = Object.keys(translations) as (keyof typeof translations)[];
    const locales: Locale[] = ['en', 'zh-CN'];
    for (const key of keys) {
      for (const loc of locales) {
        expect(t(key, loc)).toBeTruthy();
      }
    }
  });
});
